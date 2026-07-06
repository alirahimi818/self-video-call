<script setup>
import { ref, watch, onMounted } from 'vue';
import { useCall } from '../composables/useCall.js';
import { useForceRelay } from '../composables/useForceRelay.js';
import DebugOverlay from '../components/DebugOverlay.vue';

const props = defineProps({ uuid: { type: String, required: true } });

const forceRelay = useForceRelay();
const showDebug = ref(false);
const localVideo = ref(null);
const remoteVideo = ref(null);

const {
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
} = useCall(props.uuid, forceRelay);

watch(localStream, (stream) => {
  if (localVideo.value) localVideo.value.srcObject = stream;
});
watch(remoteStream, (stream) => {
  if (remoteVideo.value) remoteVideo.value.srcObject = stream;
});

onMounted(start);

function copyLink() {
  navigator.clipboard.writeText(window.location.href);
}

const statusText = {
  waiting: 'Waiting for the other person to join…',
  connected: 'Connected',
  'peer-left': 'The other person left. Waiting for them to rejoin…',
  reconnecting: 'Connection trouble, reconnecting…',
};
</script>

<template>
  <div class="call">
    <video ref="remoteVideo" class="remote-video" autoplay playsinline></video>
    <video ref="localVideo" class="local-video" autoplay playsinline muted></video>

    <div class="status-banner" v-if="peerStatus !== 'connected'">
      {{ statusText[peerStatus] }}
    </div>

    <DebugOverlay v-if="showDebug" :stats="stats" :connection-state="connectionState" />

    <div class="controls">
      <button @click="toggleMute" :class="{ active: isMuted }">
        {{ isMuted ? 'Unmute' : 'Mute' }}
      </button>
      <button @click="toggleCamera" :class="{ active: isCameraOff }">
        {{ isCameraOff ? 'Camera on' : 'Camera off' }}
      </button>
      <button @click="copyLink">Copy link</button>
      <label class="relay-toggle" title="Applies next time you join a call">
        <input type="checkbox" v-model="forceRelay" />
        Force relay
      </label>
      <button @click="showDebug = !showDebug">Debug</button>
      <button class="hangup" @click="hangup">Hang up</button>
    </div>
  </div>
</template>

<style scoped>
.call {
  position: relative;
  height: 100dvh;
  width: 100%;
  background: #111;
  overflow: hidden;
}

.remote-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
}

.local-video {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  width: 30vw;
  max-width: 160px;
  border-radius: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.3);
  object-fit: cover;
  z-index: 10;
}

.status-banner {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  right: calc(30vw + 1.5rem);
  max-width: 60%;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 0.5rem 0.75rem;
  border-radius: 0.4rem;
  font-size: 0.85rem;
  z-index: 10;
}

.controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
  padding: 0.75rem;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
  z-index: 15;
}

.controls button {
  padding: 0.6rem 0.9rem;
  border-radius: 0.5rem;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: white;
  font-size: 0.85rem;
}

.controls button.active {
  background: #dc2626;
}

.controls button.hangup {
  background: #dc2626;
}

.relay-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  color: white;
  font-size: 0.8rem;
  background: rgba(255, 255, 255, 0.1);
  padding: 0.4rem 0.6rem;
  border-radius: 0.5rem;
}
</style>
