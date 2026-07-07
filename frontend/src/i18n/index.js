import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { en } from './en.js';
import { fa } from './fa.js';

const dictionaries = { en, fa };

export function useI18n() {
  const route = useRoute();
  const locale = computed(() => route.meta.locale ?? 'en');
  const dir = computed(() => (locale.value === 'fa' ? 'rtl' : 'ltr'));

  function t(key, vars) {
    const template = dictionaries[locale.value]?.[key] ?? dictionaries.en[key] ?? key;
    if (!vars) return template;
    return Object.entries(vars).reduce(
      (str, [name, value]) => str.replaceAll(`{${name}}`, value),
      template,
    );
  }

  return { locale, dir, t };
}

// Prefixes a path with /fa when building a link for the Persian locale, so
// links created from the Persian home page stay in Persian for whoever opens
// them (e.g. /call/xxx -> /fa/call/xxx).
export function localePath(path, locale) {
  return locale === 'fa' ? `/fa${path}` : path;
}
