<script setup>
import { ref, watch, onMounted } from 'vue';
import { useCall } from '../composables/useCall.js';
import { useI18n } from '../i18n/index.js';

const props = defineProps({ uuid: { type: String, required: true } });

const { dir, t } = useI18n();
const localVideo = ref(null);
const remoteVideo = ref(null);
const justCopied = ref(false);
const startError = ref(null);

const {
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
} = useCall(props.uuid);

watch(localStream, (stream) => {
  if (localVideo.value) localVideo.value.srcObject = stream;
});
watch(remoteStream, (stream) => {
  if (remoteVideo.value) remoteVideo.value.srcObject = stream;
});

onMounted(async () => {
  try {
    await start();
  } catch (err) {
    console.error('failed to start call', err);
    startError.value = err;
  }
});

function copyLink() {
  navigator.clipboard.writeText(window.location.href);
  justCopied.value = true;
  setTimeout(() => (justCopied.value = false), 2000);
}

function errorMessageKey(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') return 'errorPermission';
  if (String(err?.message).includes('timed out')) return 'errorTimeout';
  return 'errorGeneric';
}

const statusKey = {
  starting: 'statusStarting',
  waiting: 'statusWaiting',
  connected: 'statusConnected',
  'peer-left': 'statusPeerLeft',
  reconnecting: 'statusReconnecting',
};
</script>

<template>
  <div class="call" :dir="dir">
    <div class="start-error" v-if="startError">
      <p>{{ t(errorMessageKey(startError)) }}</p>
      <button @click="() => location.reload()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
        <span>{{ t('reload') }}</span>
      </button>
    </div>

    <video ref="remoteVideo" class="remote-video" autoplay playsinline></video>
    <video ref="localVideo" class="local-video" autoplay playsinline muted></video>

    <div class="status-banner" v-if="!startError && peerStatus !== 'connected'">
      {{
        peerStatus === 'reconnecting' && wsReconnectAttempt > 0
          ? t('statusReconnectingAttempt', { n: wsReconnectAttempt })
          : t(statusKey[peerStatus])
      }}
    </div>

    <div class="controls">
      <button @click="toggleMute" :class="{ active: isMuted }" :aria-label="isMuted ? t('unmute') : t('mute')">
        <svg v-if="!isMuted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
          <path d="M17 16.95A7 7 0 0 1 5 12v-2" />
          <path d="M19 10v2a7 7 0 0 1-.11 1.23" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <span>{{ isMuted ? t('unmute') : t('mute') }}</span>
      </button>

      <button @click="toggleCamera" :class="{ active: isCameraOff }" :aria-label="isCameraOff ? t('cameraOn') : t('cameraOff')">
        <svg v-if="!isCameraOff" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
          <path d="M9.5 5H14a2 2 0 0 1 2 2v3.5" />
          <polygon points="23 7 16 12 23 17 23 7" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
        <span>{{ isCameraOff ? t('cameraOn') : t('cameraOff') }}</span>
      </button>

      <button @click="copyLink" :aria-label="t('copyLink')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        <span>{{ justCopied ? t('linkCopied') : t('copyLink') }}</span>
      </button>

      <button class="hangup" @click="hangup" :aria-label="t('hangup')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.86.31 1.77.53 2.7.63A2 2 0 0 1 22 17.72V20a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 3 5.18 2 2 0 0 1 5 3h2.28a2 2 0 0 1 2 1.72c.1.93.32 1.84.63 2.7a2 2 0 0 1-.45 2.11z" />
          <line x1="23" y1="1" x2="1" y2="23" />
        </svg>
        <span>{{ t('hangup') }}</span>
      </button>
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

.start-error {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 1.5rem;
  text-align: center;
  background: #111;
  color: white;
}

.start-error button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 1.2rem;
  border-radius: 0.5rem;
  border: none;
  background: #2563eb;
  color: white;
  font-size: 0.9rem;
}

.start-error button svg {
  width: 18px;
  height: 18px;
}

.local-video {
  position: absolute;
  top: 0.75rem;
  inset-inline-end: 0.75rem;
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
  inset-inline-start: 0.75rem;
  inset-inline-end: calc(30vw + 1.5rem);
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
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem;
  border-radius: 0.5rem;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: white;
  font-size: 0.85rem;
}

.controls button svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.controls button.active {
  background: #dc2626;
}

.controls button.hangup {
  background: #dc2626;
}
</style>
