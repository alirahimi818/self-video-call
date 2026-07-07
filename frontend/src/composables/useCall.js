import { ref, shallowRef, onBeforeUnmount } from 'vue';
import { fetchIceServers, postDebugLog } from './api.js';
import { useSignaling } from './useSignaling.js';
import { mungeOpusFmtp } from './sdpMunge.js';

const VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 24 },
  // Nudges phone cameras (which otherwise often default to their sensor's
  // native portrait shape) toward the same landscape-ish shape as a laptop
  // webcam — reduces (doesn't eliminate) the aspect-ratio mismatch that
  // makes object-fit: contain add large letterbox bars on one side.
  aspectRatio: { ideal: 16 / 9 },
};

const STATS_INTERVAL_MS = 2500;
const DEBUG_REPORT_INTERVAL_MS = 10_000;
// Every call starts at the conservative tier — the connection's real
// quality is unknown at first, and this ceiling is what actually gets
// through heavy DPI/CGNAT reliably. Only stepped up to the high tier after
// sustained good quality is actually observed (see GOOD_STREAK_TO_UPGRADE
// below), and dropped back at the first sign of trouble — no hysteresis
// needed on the way down, unlike the audio-only fallback.
const VIDEO_BITRATE_LOW = 350_000;
const VIDEO_BITRATE_HIGH = 1_500_000;
const CAPTURE_LOW = { width: 640, height: 360 };
const CAPTURE_HIGH = { width: 1280, height: 720 };
const GOOD_STREAK_TO_UPGRADE_QUALITY = 4; // ~10s of good readings
const GET_USER_MEDIA_TIMEOUT_MS = 15_000;
const FETCH_ICE_SERVERS_TIMEOUT_MS = 10_000;
// restartIce() on 'disconnected' can mask a connection that would otherwise
// reach 'failed' — repeatedly restarting resets it back to 'checking' before
// the browser ever calls it failed, so the relay-fallback below (which only
// used to trigger on 'failed') would never engage. Escalate after a few
// disconnects with no successful connection in between instead of waiting
// for a 'failed' that may never come.
const DISCONNECT_ESCALATION_THRESHOLD = 2;

// Quality-based auto audio-only: stats poll every STATS_INTERVAL_MS (2.5s),
// so these streak counts are roughly in seconds. Poor is a lower bar to
// trigger than good is to recover — deliberate hysteresis so a call doesn't
// flap video on/off right at the edge of a threshold; better to stay in
// audio-only a few seconds too long than to bounce.
const POOR_QUALITY_LOSS_PCT = 10;
const POOR_QUALITY_RTT_MS = 600;
const FAIR_QUALITY_LOSS_PCT = 3;
const FAIR_QUALITY_RTT_MS = 300;
const POOR_STREAK_TO_PAUSE_VIDEO = 3; // ~7.5s of poor readings
const GOOD_STREAK_TO_RESUME_VIDEO = 5; // ~12.5s of good readings
// If quality stays poor this long even while ICE reports 'connected', the
// path itself has probably degraded (not just gone through a blip) — a
// nominally-alive connection with terrible loss never triggers the
// disconnect/failed handling above, so nothing else would ever try a fresh
// ICE restart to look for a better path.
const POOR_STREAK_TO_RESTART_ICE = 8; // ~20s

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

// #debugQuality=poor|fair|good on the call URL forces the quality
// classification below to that value, regardless of real stats — DevTools'
// network throttling doesn't touch WebRTC's media traffic (it's a separate
// path from the fetch/XHR traffic it actually throttles), so there's no way
// to trigger the real 'poor' path in a browser tab without this. Read from
// the hash (not a query param) and re-read fresh every time (not cached at
// load) specifically so it can be changed — e.g. #debugQuality=poor, wait
// for pause, then clear the hash — without reloading the page, since a
// reload would start a whole new call session instead of testing recovery
// within the same one.
function getDebugQualityOverride() {
  const match = window.location.hash.match(/debugQuality=(good|fair|poor)/);
  return match?.[1] ?? null;
}

export function useCall(roomId) {
  const localStream = shallowRef(null);
  const remoteStream = shallowRef(null);
  const peerStatus = ref('starting'); // starting | waiting | connected | peer-left | reconnecting
  const connectionState = ref('new');
  const isMuted = ref(false);
  const isCameraOff = ref(false);
  const wsReconnectAttempt = ref(0);
  const connectionQuality = ref('good'); // good | fair | poor — only meaningful once connected
  const videoAutoPaused = ref(false);
  const stats = ref({
    candidateType: null,
    protocol: null,
    remoteCandidateType: null,
    remoteProtocol: null,
    outboundKbps: 0,
    inboundKbps: 0,
    packetLoss: null,
    audioPacketLoss: null,
    rtt: null,
  });

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
  let disconnectCount = 0;
  let lastAttemptedPairs = null;
  let videoSender = null;
  let localVideoTrack = null;
  let localQualityPause = false; // we asked ourselves to stop sending video (our own bad quality)
  let peerRequestedVideoPause = false; // the other side asked us to stop sending them video
  let poorStreak = 0;
  let goodStreak = 0;
  let sustainedPoorStreak = 0;
  let videoQualityTier = 'low'; // low | high

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
    // A fresh connection gets a fresh read on quality — don't carry over an
    // auto-pause decision (or its streak counters) made against the old,
    // now-discarded path.
    localQualityPause = false;
    peerRequestedVideoPause = false;
    poorStreak = 0;
    goodStreak = 0;
    sustainedPoorStreak = 0;
    videoQualityTier = 'low';
    videoAutoPaused.value = false;

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
        disconnectCount = 0;
      } else if (pc.iceConnectionState === 'failed') {
        fallBackToRelayOrRestart('failed');
      } else if (pc.iceConnectionState === 'disconnected') {
        disconnectCount += 1;
        if (disconnectCount >= DISCONNECT_ESCALATION_THRESHOLD) {
          fallBackToRelayOrRestart('repeated-disconnects');
        } else {
          restartIce();
        }
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

    videoSender = null;
    localVideoTrack = localStream.value.getVideoTracks()[0] ?? null;
    for (const track of localStream.value.getTracks()) {
      const sender = pc.addTrack(track, localStream.value);
      if (track.kind === 'video') videoSender = sender;
    }
    await applyVideoQualityTier();
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
      const { description, candidate, qualityHint } = event.detail;
      if (qualityHint) {
        // The other side is asking us to stop (or resume) sending them
        // video because of what THEY'RE seeing on their end — independent
        // of our own local quality reading, both must allow video for it to
        // actually flow. No renegotiation involved (replaceTrack doesn't
        // trigger it), so this applies near-instantly.
        logEvent('quality-hint-received', qualityHint);
        peerRequestedVideoPause = !qualityHint.wantVideo;
        applyVideoSendState();
        return;
      }
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

  // Adjusts both the sender's bitrate ceiling and the actual capture
  // resolution to match videoQualityTier. Bitrate alone doesn't buy much
  // visible sharpness if the source is still 360p — the resolution bump is
  // what actually matters, and applyConstraints() can change it on the
  // live track without re-negotiation (same trick as replaceTrack above).
  async function applyVideoQualityTier() {
    const bitrate = videoQualityTier === 'high' ? VIDEO_BITRATE_HIGH : VIDEO_BITRATE_LOW;
    const capture = videoQualityTier === 'high' ? CAPTURE_HIGH : CAPTURE_LOW;

    if (videoSender) {
      try {
        const params = videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = bitrate;
        params.encodings[0].degradationPreference = 'maintain-framerate';
        params.degradationPreference = 'maintain-framerate';
        await videoSender.setParameters(params);
      } catch (err) {
        logEvent('error', { context: 'video-bitrate', message: String(err) });
      }
    }

    if (localVideoTrack) {
      try {
        await localVideoTrack.applyConstraints({
          width: { ideal: capture.width },
          height: { ideal: capture.height },
          aspectRatio: { ideal: 16 / 9 },
        });
      } catch (err) {
        logEvent('error', { context: 'video-resolution', message: String(err) });
      }
    }

    logEvent('video-quality-tier', { tier: videoQualityTier, bitrate, capture });
  }

  function restartIce() {
    if (!pc || pc.signalingState === 'closed') return;
    peerStatus.value = 'reconnecting';
    pc.restartIce();
  }

  function fallBackToRelayOrRestart(reason) {
    if (!relayOnly) {
      // A direct/srflx path didn't work out — rebuild the connection
      // forced to relay-only instead of just restarting ICE with the
      // same candidate policy that already failed.
      logEvent('relay-fallback-triggered', { reason });
      relayOnly = true;
      disconnectCount = 0;
      peerStatus.value = 'reconnecting';
      createPeerConnection().catch((err) => logEvent('error', { context: 'relay-fallback', message: String(err) }));
    } else {
      restartIce();
    }
  }

  // 'poor'/'fair'/'good' from the same loss/RTT numbers already shown to
  // nobody (no debug UI) — used here to drive auto audio-only and, for the
  // UI, a simple traffic-light indicator instead of raw numbers.
  function classifyQuality({ packetLoss, audioPacketLoss, rtt }) {
    const loss = Math.max(packetLoss ?? 0, audioPacketLoss ?? 0);
    const rttMs = rtt ?? 0;
    if (loss > POOR_QUALITY_LOSS_PCT || rttMs > POOR_QUALITY_RTT_MS) return 'poor';
    if (loss > FAIR_QUALITY_LOSS_PCT || rttMs > FAIR_QUALITY_RTT_MS) return 'fair';
    return 'good';
  }

  function sendQualityHint(wantVideo) {
    signaling?.send({ qualityHint: { wantVideo } });
  }

  // Video only actually flows if neither side asked for it to stop (our own
  // bad quality, the peer's bad quality) and the user hasn't manually
  // turned the camera off. replaceTrack(null)/back doesn't trigger
  // renegotiation, so this takes effect immediately either way.
  async function applyVideoSendState() {
    if (!videoSender) return;
    const shouldSend = !localQualityPause && !peerRequestedVideoPause && !isCameraOff.value;
    const currentlySending = videoSender.track !== null;
    if (shouldSend === currentlySending) return;
    try {
      await videoSender.replaceTrack(shouldSend ? localVideoTrack : null);
    } catch (err) {
      logEvent('error', { context: 'video-send-state', message: String(err) });
    }
    videoAutoPaused.value = localQualityPause || peerRequestedVideoPause;
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
    // If quality auto-pause had already replaced the sender's track with
    // null, just re-enabling the local track above wouldn't resume sending
    // — the sender needs its track put back explicitly.
    applyVideoSendState();
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
      if (!activePair) {
        // Not connected yet (or not anymore) — capture what was actually
        // tried and why, since getStats() only exposes this for as long as
        // the pair exists. Without this, a stuck/failed connection just
        // shows up as "nothing", with no clue which local/remote candidate
        // combinations were attempted or what state they ended up in.
        const attemptedPairs = [];
        report.forEach((entry) => {
          if (entry.type !== 'candidate-pair') return;
          const local = report.get(entry.localCandidateId);
          const remote = report.get(entry.remoteCandidateId);
          attemptedPairs.push({
            state: entry.state,
            localType: local?.candidateType ?? null,
            localProtocol: local?.protocol ?? null,
            remoteType: remote?.candidateType ?? null,
            remoteProtocol: remote?.protocol ?? null,
          });
        });
        lastAttemptedPairs = attemptedPairs.length > 0 ? attemptedPairs : null;
        return;
      }
      lastAttemptedPairs = null;

      const localCandidate = report.get(activePair.localCandidateId);
      const remoteCandidate = report.get(activePair.remoteCandidateId);

      let outboundKbps = 0;
      let inboundKbps = 0;
      let packetLoss = null;
      let audioPacketLoss = null;
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
        // Audio is the priority to keep alive even when video degrades —
        // track its loss separately so a bad-but-audio-only call is visible.
        if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
          if (entry.packetsLost != null && entry.packetsReceived != null) {
            const total = entry.packetsLost + entry.packetsReceived;
            audioPacketLoss = total > 0 ? Math.round((entry.packetsLost / total) * 1000) / 10 : 0;
          }
        }
      });

      const rtt = activePair.currentRoundTripTime != null ? Math.round(activePair.currentRoundTripTime * 1000) : null;

      stats.value = {
        candidateType: localCandidate?.candidateType ?? null,
        protocol: localCandidate?.protocol ?? null,
        remoteCandidateType: remoteCandidate?.candidateType ?? null,
        remoteProtocol: remoteCandidate?.protocol ?? null,
        outboundKbps,
        inboundKbps,
        packetLoss,
        audioPacketLoss,
        rtt,
      };

      // Only judge quality once genuinely connected — 'checking'/'new' would
      // otherwise look like packet loss and immediately (and pointlessly)
      // trigger audio-only before the call ever really started.
      if (connectionState.value !== 'connected' && connectionState.value !== 'completed') return;

      const quality = getDebugQualityOverride() || classifyQuality({ packetLoss, audioPacketLoss, rtt });
      connectionQuality.value = quality;

      if (quality === 'poor') {
        poorStreak += 1;
        goodStreak = 0;
        sustainedPoorStreak += 1;
      } else if (quality === 'good') {
        goodStreak += 1;
        poorStreak = 0;
        sustainedPoorStreak = 0;
      } else {
        // 'fair' is a neutral middle ground: not bad enough to keep pushing
        // toward audio-only, not good enough to count toward recovery.
        poorStreak = 0;
        goodStreak = 0;
        sustainedPoorStreak = 0;
      }

      if (poorStreak >= POOR_STREAK_TO_PAUSE_VIDEO && !localQualityPause) {
        logEvent('video-auto-pause', { reason: 'local-quality', packetLoss, audioPacketLoss, rtt });
        localQualityPause = true;
        sendQualityHint(false);
        applyVideoSendState();
      } else if (goodStreak >= GOOD_STREAK_TO_RESUME_VIDEO && localQualityPause) {
        logEvent('video-auto-resume', { reason: 'local-quality' });
        localQualityPause = false;
        sendQualityHint(true);
        applyVideoSendState();
      }

      if (sustainedPoorStreak >= POOR_STREAK_TO_RESTART_ICE) {
        sustainedPoorStreak = 0;
        logEvent('proactive-ice-restart', { packetLoss, audioPacketLoss, rtt });
        pc.restartIce();
      }

      // Bitrate/resolution ceiling: drop immediately at any sign of trouble
      // (no hysteresis needed going down — a smaller/lower-bitrate frame is
      // never a bad response to bad conditions), but only step up after
      // quality has actually been good for a while, same spirit as the
      // audio-only recovery above.
      if (quality !== 'good' && videoQualityTier === 'high') {
        videoQualityTier = 'low';
        applyVideoQualityTier();
      } else if (
        quality === 'good' &&
        goodStreak >= GOOD_STREAK_TO_UPGRADE_QUALITY &&
        videoQualityTier === 'low'
      ) {
        videoQualityTier = 'high';
        applyVideoQualityTier();
      }
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
        iceGatheringState: pc?.iceGatheringState ?? null,
        relayOnly,
        wsReconnectAttempt: wsReconnectAttempt.value,
        visibilityState: document.visibilityState,
        userAgent: navigator.userAgent,
        network: getNetworkInfo(),
        disconnectCount,
        attemptedPairs: lastAttemptedPairs,
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
    connectionQuality,
    videoAutoPaused,
    start,
    toggleMute,
    toggleCamera,
    hangup,
  };
}
