import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { createRoom, getRoom, deleteRoomIfEmpty } from './rooms.js';
import { generateTurnCredentials, buildIceServers } from './turn.js';
import { appendDebugLog } from './debugLog.js';

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.TURN_SHARED_SECRET;
const TURN_HOST = process.env.TURN_HOST;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_DEBUG_BODY_BYTES = 4096;

if (!SHARED_SECRET) {
  throw new Error('TURN_SHARED_SECRET env var is required');
}
if (!TURN_HOST) {
  throw new Error('TURN_HOST env var is required');
}

// Caddy's reverse_proxy sets X-Forwarded-For by default; fall back to the
// raw socket address for direct connections (e.g. local testing).
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
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

  const debugMatch = pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/debug$/i);
  if (req.method === 'POST' && debugMatch) {
    const roomId = debugMatch[1];
    if (!isUuid(roomId)) {
      return sendJson(res, 400, { error: 'invalid room id' });
    }
    let body;
    try {
      body = await readJsonBody(req, MAX_DEBUG_BODY_BYTES);
    } catch {
      return sendJson(res, 400, { error: 'invalid body' });
    }
    appendDebugLog({
      roomId,
      clientIp: getClientIp(req),
      userAgentHeader: req.headers['user-agent'],
      host: req.headers.host,
      allHeaders: req.headers, // TEMP: figuring out how to tell CDNs apart, remove after
      ...body,
    });
    res.writeHead(204);
    return res.end();
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      console.error('API error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
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
  ws.clientIp = getClientIp(req);
  ws.host = req.headers.host;
  console.log(`[room ${roomId}] peer joined (${room.peers.size}/2) ip=${ws.clientIp} host=${ws.host}`);

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
    const raw = data.toString();
    // Peeking at the message type is purely for diagnostics (did the offer/
    // answer/candidate actually reach the other peer, or get dropped because
    // no live peer was found?) — relay itself stays blind, forwarding the
    // raw string unparsed either way.
    let kind = 'unknown';
    try {
      const parsed = JSON.parse(raw);
      kind = parsed.description?.type ?? (parsed.candidate ? 'candidate' : 'unknown');
    } catch {
      // ignore — still relay raw below
    }

    const otherPeer = [...room.peers].find((peer) => peer !== ws);
    if (otherPeer && otherPeer.readyState === otherPeer.OPEN) {
      otherPeer.send(raw);
      console.log(
        `[room ${roomId}] relayed ${kind} ip=${ws.clientIp} host=${ws.host} -> ip=${otherPeer.clientIp} host=${otherPeer.host}`,
      );
    } else {
      console.log(
        `[room ${roomId}] dropped ${kind} from ip=${ws.clientIp} host=${ws.host}: no live peer to relay to (readyState=${otherPeer?.readyState ?? 'none'})`,
      );
    }
  });

  ws.on('close', (code, reason) => {
    room.peers.delete(ws);
    // Code 1006 (no close frame received) usually means the network just
    // vanished (dead interface, DPI interference) rather than a clean
    // client-initiated close (1000/1001) — useful to tell apart when
    // diagnosing connection instability.
    console.log(
      `[room ${roomId}] peer left (${room.peers.size}/2) ip=${ws.clientIp} host=${ws.host} code=${code} reason=${reason?.toString() || ''}`,
    );
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
      console.log(
        `[room ${ws.roomId}] terminating unresponsive connection (missed heartbeat) ip=${ws.clientIp} host=${ws.host}`,
      );
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
