import { ref } from 'vue';
import { wsUrl } from './api.js';

const MAX_BACKOFF_MS = 10_000;

// Thin reconnecting WebSocket wrapper around an EventTarget so callers can
// addEventListener for 'joined' | 'peer-joined' | 'peer-left' | 'signal' | 'open' | 'close'.
export function useSignaling(roomId) {
  const events = new EventTarget();
  const status = ref('connecting'); // connecting | open | closed
  let ws = null;
  let attempt = 0;
  let closedByUser = false;
  let reconnectTimer = null;

  function connect() {
    ws = new WebSocket(wsUrl(roomId));

    ws.addEventListener('open', () => {
      attempt = 0;
      status.value = 'open';
      events.dispatchEvent(new Event('open'));
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'joined' || msg.type === 'peer-joined' || msg.type === 'peer-left') {
        events.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
      } else {
        // SDP offer/answer or ICE candidate — relayed blindly by the server.
        events.dispatchEvent(new CustomEvent('signal', { detail: msg }));
      }
    });

    ws.addEventListener('close', () => {
      status.value = 'closed';
      events.dispatchEvent(new Event('close'));
      if (!closedByUser) scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt += 1;
    status.value = 'connecting';
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function close() {
    closedByUser = true;
    clearTimeout(reconnectTimer);
    ws?.close();
  }

  connect();

  return { events, status, send, close };
}
