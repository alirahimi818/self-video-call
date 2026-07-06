<script setup>
defineProps({
  stats: { type: Object, required: true },
  connectionState: { type: String, required: true },
});
</script>

<template>
  <div class="debug-overlay">
    <div>state: {{ connectionState }}</div>
    <div>path: {{ stats.candidateType ?? '–' }} / {{ stats.protocol ?? '–' }}</div>
    <div>out: {{ stats.outboundKbps }} kbps</div>
    <div>in: {{ stats.inboundKbps }} kbps</div>
    <div>loss: {{ stats.packetLoss ?? '–' }}%</div>
    <div>rtt: {{ stats.rtt ?? '–' }} ms</div>
  </div>
</template>

<style scoped>
.debug-overlay {
  position: fixed;
  bottom: 5rem;
  right: 0.5rem;
  background: rgba(0, 0, 0, 0.7);
  color: #0f0;
  font-family: monospace;
  font-size: 0.7rem;
  padding: 0.5rem 0.6rem;
  border-radius: 0.4rem;
  line-height: 1.4;
  z-index: 20;
  pointer-events: none;
}
</style>
