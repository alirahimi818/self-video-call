<script setup>
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { createRoom } from '../composables/api.js';
import { useI18n, localePath, domainLabel } from '../i18n/index.js';
import { DOMAINS } from '../domains.js';

const router = useRouter();
const { locale, dir, t } = useI18n();
const isCreating = ref(false);
const error = ref('');

// Shown so a user stuck on a broken/blocked link can try the others
// themselves, instead of needing the URLs relayed over chat.
const otherDomains = computed(() => DOMAINS.filter((entry) => entry.domain !== window.location.hostname));

async function startCall() {
  isCreating.value = true;
  error.value = '';
  try {
    const { roomId } = await createRoom();
    router.push(localePath(`/call/${roomId}`, locale.value));
  } catch (err) {
    error.value = t('createError');
  } finally {
    isCreating.value = false;
  }
}
</script>

<template>
  <main class="home" :dir="dir">
    <router-link class="lang-switch" :to="locale === 'fa' ? '/' : '/fa'">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      {{ t('switchLanguage') }}
    </router-link>

    <h1>{{ t('appTitle') }}</h1>
    <p>{{ t('tagline') }}</p>
    <button class="primary" :disabled="isCreating" @click="startCall">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      {{ isCreating ? t('creating') : t('startCall') }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>

    <div class="alt-domains" v-if="otherDomains.length">
      <p>{{ t('altDomainsTitle') }}</p>
      <a v-for="entry in otherDomains" :key="entry.domain" :href="`https://${entry.domain}${$route.fullPath}`">
        {{ domainLabel(t, entry) }}
      </a>
    </div>
  </main>
</template>

<style scoped>
.home {
  position: relative;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 1.5rem;
  text-align: center;
}

.lang-switch {
  position: absolute;
  top: 1rem;
  inset-inline-end: 1rem;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: inherit;
  text-decoration: none;
  font-size: 0.9rem;
  opacity: 0.8;
}

.lang-switch svg {
  width: 18px;
  height: 18px;
}

.primary {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.9rem 2rem;
  font-size: 1.1rem;
  border-radius: 0.6rem;
  border: none;
  background: #2563eb;
  color: white;
  cursor: pointer;
}

.primary svg {
  width: 20px;
  height: 20px;
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  color: #dc2626;
}

.alt-domains {
  margin-top: 2rem;
  font-size: 0.8rem;
  opacity: 0.75;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
}

.alt-domains a {
  color: inherit;
}
</style>
