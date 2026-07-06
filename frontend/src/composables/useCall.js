import { ref, shallowRef, onBeforeUnmount } from 'vue';
import { fetchIceServers } from './api.js';
import { useSignaling } from './useSignaling.js';
import { mungeOpusFmtp } from './sdpMunge.js';

const VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 24 },
};

const STATS_INTERVAL_MS = 2500;
const VIDEO_MAX_BITRATE = 350_000;

export function useCall(roomId, forceRelay) {
  const localStream = shallowRef(null);
  const remoteStream = shallowRef(null);
  const peerStatus = ref('waiting'); // waiting | connected | peer-left | reconnecting
  const connectionState = ref('new');
  const isMuted = ref(false);
  const isCameraOff = ref(false);
  const stats = ref({ candidateType: null, protocol: null, outboundKbps: 0, inboundKbps: 0, packetLoss: null, rtt: null });

  let pc = null;
  let signaling = null;
  let polite = true;
  let makingOffer = false;
  let ignoreOffer = false;
  let statsTimer = null;
  let lastStats = null;

  async function start() {
    localStream.value = await navigator.mediaDevices.getUserMedia({
      video: VIDEO_CONSTRAINTS,
      audio: true,
    });
    const [videoTrack] = localStream.value.getVideoTracks();
    if (videoTrack) videoTrack.contentHint = 'motion';

    const { iceServers } = await fetchIceServers(roomId);

    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: forceRelay.value ? 'relay' : 'all',
    });

    for (const track of localStream.value.getTracks()) {
      pc.addTrack(track, localStream.value);
    }
    await applyVideoBitrateLimit();

    remoteStream.value = new MediaStream();
    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        remoteStream.value.addTrack(track);
      }
    };

    pc.oniceconnectionstatechange = () => {
      connectionState.value = pc.iceConnectionState;
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        peerStatus.value = 'connected';
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        restartIce();
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) signaling.send({ candidate });
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
      } finally {
        makingOffer = false;
      }
    };

    signaling = useSignaling(roomId);

    let hasConnectedBefore = false;
    signaling.events.addEventListener('open', () => {
      // A WS reconnect after a drop needs a fresh offer/answer exchange
      // since ICE state may be stale on one or both sides.
      if (hasConnectedBefore && pc && pc.signalingState !== 'closed') {
        pc.restartIce();
      }
      hasConnectedBefore = true;
    });

    signaling.events.addEventListener('joined', (event) => {
      polite = event.detail.peerCount === 1;
    });

    signaling.events.addEventListener('peer-left', () => {
      peerStatus.value = 'peer-left';
    });

    signaling.events.addEventListener('peer-joined', () => {
      peerStatus.value = 'waiting';
    });

    signaling.events.addEventListener('signal', async (event) => {
      const { description, candidate } = event.detail;
      try {
        if (description) {
          const offerCollision =
            description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) return;

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
      }
    });

    startStatsPolling();
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

  function hangup() {
    clearInterval(statsTimer);
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
    connectionState,
    stats,
    isMuted,
    isCameraOff,
    start,
    toggleMute,
    toggleCamera,
    hangup,
  };
}
