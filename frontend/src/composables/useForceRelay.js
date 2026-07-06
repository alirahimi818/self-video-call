import { ref, watch } from 'vue';

const STORAGE_KEY = 'forceRelay';

export function useForceRelay() {
  const forceRelay = ref(localStorage.getItem(STORAGE_KEY) === 'true');

  watch(forceRelay, (value) => {
    localStorage.setItem(STORAGE_KEY, String(value));
  });

  return forceRelay;
}
