import { ref, shallowRef, onBeforeUnmount } from 'vue';
import { fetchIceServers, postDebugLog } from './api.js';
import { useSignaling } from './useSignaling.js';
import { mungeOpusFmtp } from './sdpMunge.js';

const VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 24 },
};

const STATS_INTERVAL_MS = 2500;
const DEBUG_REPORT_INTERVAL_MS = 10_000;
const VIDEO_MAX_BITRATE = 350_000;
const GET_USER_MEDIA_TIMEOUT_MS = 15_000;
const FETCH_ICE_SERVERS_TIMEOUT_MS = 10_000;

function getNetworkInfo() {
  const conn = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
  if (!conn) return null;
  return { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt, saveData: conn.saveData };
}

// getUserMedia/fetch can hang indefinitely (a stuck permission prompt, a
// network path that never errors, just never responds) with zero feedback —
// the call start()s, nothing throws, nothing logs, the page just sits there.
// Race against a timeout so a hang always turns into a visible, logged error.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export function useCall(roomId) {
  const localStream = shallowRef(null);
  const remoteStream = shallowRef(null);
  const peerStatus = ref('starting'); // starting | waiting | connected | peer-left | reconnecting
  const connectionState = ref('new');
  const isMuted = ref(false);
  const isCameraOff = ref(false);
  const wsReconnectAttempt = ref(0);
  const stats = ref({ candidateType: null, protocol: null, outboundKbps: 0, inboundKbps: 0, packetLoss: null, rtt: null });

  // Identifies all log lines from this one page load/session, so entries
  // from the two peers (interleaved in the same room's log) and across
  // this client's own reconnects can be told apart.
  const sessionId = Math.random().toString(36).slice(2, 10);

  let pc = null;
  let signaling = null;
  let iceServers = null;
  let polite = true;
  let politeAssigned = false;
  let makingOffer = false;
  let ignoreOffer = false;
  let relayOnly = false;
  let statsTimer = null;
  let debugTimer = null;
  let lastStats = null;
  let seenCandidateTypes = new Set();

  // Best-effort, fire-and-forget event log shipped to the server immediately
  // (as opposed to the periodic snapshot below) so the exact sequence of
  // what happened is reconstructable after the fact — see
  // node-service/debugLog.js for where this ends up.
  function logEvent(type, data = {}) {
    postDebugLog(roomId, { type, sessionId, ...data });
  }

  // Builds a fresh RTCPeerConnection with all handlers and local tracks
  // wired up. Called once from start(), and again from the 'peer-left'
  // handler below: once the other side has fully left the room, the old
  // pc's ICE/SDP state has nothing left to talk to, and trying to nurse it
  // back to life (ICE restart, stale offers, politeness bookkeeping) is a
  // losing game — a rejoining peer always shows up with a brand-new
  // RTCPeerConnection of its own, so the cleanest way to meet it is with
  // one too.
  async function createPeerConnection() {
    if (pc) pc.close();
    seenCandidateTypes = new Set();

    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
    });

    remoteStream.value = new MediaStream();
    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        remoteStream.value.addTrack(track);
      }
    };

    pc.oniceconnectionstatechange = () => {
      connectionState.value = pc.iceConnectionState;
      logEvent('ice-state', { state: pc.iceConnectionState, relayOnly });

      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        peerStatus.value = 'connected';
      } else if (pc.iceConnectionState === 'failed') {
        if (!relayOnly) {
          // A direct/srflx path didn't work out — rebuild the connection
          // forced to relay-only instead of just restarting ICE with the
          // same candidate policy that already failed.
          logEvent('relay-fallback-triggered');
          relayOnly = true;
          peerStatus.value = 'reconnecting';
          createPeerConnection().catch((err) => logEvent('error', { context: 'relay-fallback', message: String(err) }));
        } else {
          restartIce();
        }
      } else if (pc.iceConnectionState === 'disconnected') {
        restartIce();
      }
    };

    pc.onicegatheringstatechange = () => {
      logEvent('ice-gathering-state', { state: pc.iceGatheringState });
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      signaling.send({ candidate });
      // Log the first time each candidate type (host/srflx/relay/prflx)
      // shows up this gathering pass — cheap signal for "did we even
      // manage to gather a relay candidate at all", without logging every
      // single candidate.
      if (!seenCandidateTypes.has(candidate.type)) {
        seenCandidateTypes.add(candidate.type);
        logEvent('ice-candidate-type-seen', { candidateType: candidate.type, protocol: candidate.protocol });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        const offer = await pc.createOffer();
        offer.sdp = mungeOpusFmtp(offer.sdp);
        await pc.setLocalDescription(offer);
        signaling.send({ description: pc.localDescription });
      } catch (err) {
        console.error('negotiation failed', err);
        logEvent('error', { context: 'negotiationneeded', message: String(err) });
      } finally {
        makingOffer = false;
      }
    };

    for (const track of localStream.value.getTracks()) {
      pc.addTrack(track, localStream.value);
    }
    await applyVideoBitrateLimit();
  }

  async function start() {
    // Logged before getUserMedia/fetchIceServers (which can hang or fail
    // with zero other signal) specifically so a client that never gets any
    // further still leaves a trace: "it reached the page and started, then
    // nothing" is itself a useful diagnosis, and previously indistinguishable
    // from "never loaded the page at all".
    logEvent('call-attempt', { userAgent: navigator.userAgent, network: getNetworkInfo() });

    try {
      localStream.value = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: true }),
        GET_USER_MEDIA_TIMEOUT_MS,
        'getUserMedia',
      );
    } catch (err) {
      logEvent('error', { context: 'getUserMedia', name: err?.name, message: String(err) });
      throw err;
    }
    const [videoTrack] = localStream.value.getVideoTracks();
    if (videoTrack) videoTrack.contentHint = 'motion';

    try {
      ({ iceServers } = await withTimeout(fetchIceServers(roomId), FETCH_ICE_SERVERS_TIMEOUT_MS, 'fetchIceServers'));
    } catch (err) {
      logEvent('error', { context: 'fetchIceServers', message: String(err) });
      throw err;
    }

    logEvent('session-start', { userAgent: navigator.userAgent, network: getNetworkInfo() });
    peerStatus.value = 'waiting';

    // signaling must exist before createPeerConnection() below: 'negotiationneeded'
    // and ICE candidates fire asynchronously and call signaling.send(), and if
    // they fire before it's assigned, the event is lost and neither side ever
    // creates an offer.
    signaling = useSignaling(roomId);
    wsReconnectAttempt.value = 0;

    let hasConnectedBefore = false;
    signaling.events.addEventListener('open', () => {
      logEvent('ws-open');
      wsReconnectAttempt.value = 0;
      // A WS reconnect after a drop needs a fresh offer/answer exchange
      // since ICE state may be stale on one or both sides.
      if (hasConnectedBefore && pc && pc.signalingState !== 'closed') {
        pc.restartIce();
      }
      hasConnectedBefore = true;
    });

    signaling.events.addEventListener('close', (event) => {
      logEvent('ws-close', event.detail);
    });

    signaling.events.addEventListener('reconnect-scheduled', (event) => {
      wsReconnectAttempt.value = event.detail.attempt;
      logEvent('ws-reconnect-scheduled', event.detail);
    });

    signaling.events.addEventListener('joined', (event) => {
      logEvent('joined', event.detail);
      // Only the very first join decides politeness. A WS reconnect (e.g.
      // after a network switch) re-triggers 'joined' with whatever peerCount
      // the room happens to have at that moment, which has nothing to do
      // with this client's original role — reassigning it here could flip
      // both peers to impolite (if the other side's role never changes),
      // and impolite/impolite means each side ignores the other's offer
      // during any collision, deadlocking the reconnect forever.
      if (politeAssigned) return;
      polite = event.detail.peerCount === 1;
      politeAssigned = true;
    });

    signaling.events.addEventListener('peer-left', () => {
      logEvent('peer-left');
      peerStatus.value = 'peer-left';
      // The old pc was talking to a peer that's now completely gone —
      // start fresh so we're in a clean 'stable' state, ready to accept
      // whatever offer the rejoining peer's own brand-new pc sends, rather
      // than juggling stale ICE state / a dangling local offer / politeness
      // edge cases on a connection with nothing left on the other end.
      polite = true;
      makingOffer = false;
      ignoreOffer = false;
      lastStats = null;
      createPeerConnection().catch((err) => logEvent('error', { context: 'peer-left-reset', message: String(err) }));
    });

    signaling.events.addEventListener('peer-joined', () => {
      logEvent('peer-joined');
      peerStatus.value = 'waiting';
    });

    signaling.events.addEventListener('signal', async (event) => {
      const { description, candidate } = event.detail;
      try {
        if (description) {
          const offerCollision =
            description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) {
            logEvent('offer-ignored', { polite, signalingState: pc.signalingState });
            return;
          }

          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            const answer = await pc.createAnswer();
            answer.sdp = mungeOpusFmtp(answer.sdp);
            await pc.setLocalDescription(answer);
            signaling.send({ description: pc.localDescription });
          }
        } else if (candidate) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            if (!ignoreOffer) throw err;
          }
        }
      } catch (err) {
        console.error('signal handling failed', err);
        logEvent('error', { context: 'signal-handling', message: String(err) });
      }
    });

    await createPeerConnection();

    startStatsPolling();
    startDebugReporting();
  }

  async function applyVideoBitrateLimit() {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
    params.encodings[0].degradationPreference = 'maintain-framerate';
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  }

  function restartIce() {
    if (!pc || pc.signalingState === 'closed') return;
    peerStatus.value = 'reconnecting';
    pc.restartIce();
  }

  function toggleMute() {
    if (!localStream.value) return;
    isMuted.value = !isMuted.value;
    for (const track of localStream.value.getAudioTracks()) {
      track.enabled = !isMuted.value;
    }
  }

  function toggleCamera() {
    if (!localStream.value) return;
    isCameraOff.value = !isCameraOff.value;
    for (const track of localStream.value.getVideoTracks()) {
      track.enabled = !isCameraOff.value;
    }
  }

  function startStatsPolling() {
    statsTimer = setInterval(async () => {
      if (!pc) return;
      const report = await pc.getStats();
      let activePair = null;
      report.forEach((entry) => {
        if (entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded') {
          activePair = entry;
        }
      });
      if (!activePair) return;

      const localCandidate = report.get(activePair.localCandidateId);
      const remoteCandidate = report.get(activePair.remoteCandidateId);

      let outboundKbps = 0;
      let inboundKbps = 0;
      let packetLoss = null;
      report.forEach((entry) => {
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
          if (lastStats?.outbound) {
            const bytesDelta = entry.bytesSent - lastStats.outbound.bytesSent;
            const timeDelta = (entry.timestamp - lastStats.outbound.timestamp) / 1000;
            outboundKbps = timeDelta > 0 ? Math.round((bytesDelta * 8) / timeDelta / 1000) : 0;
          }
          lastStats = { ...lastStats, outbound: entry };
        }
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
          if (lastStats?.inbound) {
            const bytesDelta = entry.bytesReceived - lastStats.inbound.bytesReceived;
            const timeDelta = (entry.timestamp - lastStats.inbound.timestamp) / 1000;
            inboundKbps = timeDelta > 0 ? Math.round((bytesDelta * 8) / timeDelta / 1000) : 0;
          }
          if (entry.packetsLost != null && entry.packetsReceived != null) {
            const total = entry.packetsLost + entry.packetsReceived;
            packetLoss = total > 0 ? Math.round((entry.packetsLost / total) * 1000) / 10 : 0;
          }
          lastStats = { ...lastStats, inbound: entry };
        }
      });

      stats.value = {
        candidateType: localCandidate?.candidateType ?? null,
        protocol: localCandidate?.protocol ?? null,
        outboundKbps,
        inboundKbps,
        packetLoss,
        rtt: activePair.currentRoundTripTime != null ? Math.round(activePair.currentRoundTripTime * 1000) : null,
      };
    }, STATS_INTERVAL_MS);
  }

  // No visible debug UI — instead, periodically ship the same connection
  // stats to the server so the Iran side's call quality can be diagnosed
  // from server logs after the fact (see node-service/debugLog.js). This is
  // a snapshot on a timer; logEvent() above covers the discrete moments
  // (state transitions, errors) in between snapshots.
  function startDebugReporting() {
    debugTimer = setInterval(() => {
      postDebugLog(roomId, {
        type: 'snapshot',
        sessionId,
        peerStatus: peerStatus.value,
        connectionState: connectionState.value,
        relayOnly,
        wsReconnectAttempt: wsReconnectAttempt.value,
        ...stats.value,
      });
    }, DEBUG_REPORT_INTERVAL_MS);
  }

  function hangup() {
    clearInterval(statsTimer);
    clearInterval(debugTimer);
    signaling?.close();
    pc?.close();
    for (const track of localStream.value?.getTracks() ?? []) {
      track.stop();
    }
  }

  onBeforeUnmount(hangup);

  return {
    localStream,
    remoteStream,
    peerStatus,
    isMuted,
    isCameraOff,
    wsReconnectAttempt,
    start,
    toggleMute,
    toggleCamera,
    hangup,
  };
}
