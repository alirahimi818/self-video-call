// Same-origin API base — Caddy reverse-proxies /api to node-service.
const API_BASE = '/api';

export async function createRoom() {
  const res = await fetch(`${API_BASE}/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error('failed to create room');
  return res.json(); // { roomId }
}

export async function fetchIceServers(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/credentials`);
  if (!res.ok) throw new Error('failed to fetch TURN credentials');
  return res.json(); // { iceServers, ttl }
}

export function wsUrl(roomId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?room=${roomId}`;
}
