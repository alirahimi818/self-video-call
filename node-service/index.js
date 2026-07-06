import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { createRoom, getRoom, deleteRoomIfEmpty } from './rooms.js';
import { generateTurnCredentials, buildIceServers } from './turn.js';

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.TURN_SHARED_SECRET;
const TURN_HOST = process.env.TURN_HOST;
const HEARTBEAT_INTERVAL_MS = 30_000;

if (!SHARED_SECRET) {
  throw new Error('TURN_SHARED_SECRET env var is required');
}
if (!TURN_HOST) {
  throw new Error('TURN_HOST env var is required');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/rooms') {
    const roomId = uuidv4();
    createRoom(roomId);
    return sendJson(res, 201, { roomId });
  }

  const credMatch = pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/credentials$/i);
  if (req.method === 'GET' && credMatch) {
    const roomId = credMatch[1];
    if (!isUuid(roomId)) {
      return sendJson(res, 400, { error: 'invalid room id' });
    }
    const creds = generateTurnCredentials(SHARED_SECRET, roomId);
    const iceServers = buildIceServers(creds, TURN_HOST);
    return sendJson(res, 200, { iceServers, ttl: creds.ttl });
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const roomId = searchParams.get('room');

  if (!roomId || !isUuid(roomId)) {
    ws.close(4000, 'invalid room');
    return;
  }

  const room = createRoom(roomId);

  // A flaky connection can leave a socket in room.peers whose underlying
  // connection is already gone but hasn't been caught by the 30s heartbeat
  // yet. Prune those before deciding the room is full, so a real reconnect
  // isn't rejected because of its own stale previous socket.
  for (const peer of room.peers) {
    if (peer.readyState !== peer.OPEN) {
      room.peers.delete(peer);
    }
  }

  if (room.peers.size >= 2) {
    console.log(`[room ${roomId}] rejected: full`);
    ws.close(4001, 'room full');
    return;
  }

  room.peers.add(ws);
  ws.isAlive = true;
  ws.roomId = roomId;
  console.log(`[room ${roomId}] peer joined (${room.peers.size}/2)`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Tell the newcomer whether a peer is already present, and tell the
  // existing peer that someone joined (client uses this to start the offer).
  const otherPeers = [...room.peers].filter((p) => p !== ws);
  ws.send(JSON.stringify({ type: 'joined', peerCount: room.peers.size }));
  for (const peer of otherPeers) {
    peer.send(JSON.stringify({ type: 'peer-joined' }));
  }

  ws.on('message', (data) => {
    // Blind relay: no parsing beyond delivering to the other peer.
    for (const peer of room.peers) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(data.toString());
      }
    }
  });

  ws.on('close', () => {
    room.peers.delete(ws);
    console.log(`[room ${roomId}] peer left (${room.peers.size}/2)`);
    for (const peer of room.peers) {
      if (peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'peer-left' }));
      }
    }
    deleteRoomIfEmpty(roomId);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`node-service listening on :${PORT}`);
});
