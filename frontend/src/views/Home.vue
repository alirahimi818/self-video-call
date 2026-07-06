<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { createRoom } from '../composables/api.js';

const router = useRouter();
const isCreating = ref(false);
const error = ref('');

async function startCall() {
  isCreating.value = true;
  error.value = '';
  try {
    const { roomId } = await createRoom();
    router.push(`/call/${roomId}`);
  } catch (err) {
    error.value = 'Could not create a call. Try again.';
  } finally {
    isCreating.value = false;
  }
}
</script>

<template>
  <main class="home">
    <h1>Private Video Call</h1>
    <p>Create a link and share it with the other person. Nobody else needs it.</p>
    <button class="primary" :disabled="isCreating" @click="startCall">
      {{ isCreating ? 'Creating…' : 'Start a call' }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
  </main>
</template>

<style scoped>
.home {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 1.5rem;
  text-align: center;
}

.primary {
  padding: 0.9rem 2rem;
  font-size: 1.1rem;
  border-radius: 0.6rem;
  border: none;
  background: #2563eb;
  color: white;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  color: #dc2626;
}
</style>
