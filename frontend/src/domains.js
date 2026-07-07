// Same app, reachable through different ingress paths (direct / Cloudflare /
// BunnyCDN) — if one is blocked or throttled, another might not be.
// labelKey/providerKey are i18n keys (see i18n/en.js, i18n/fa.js).
export const DOMAINS = [
  { domain: 'pvc.ali-rahimi.me', labelKey: 'domainMain' },
  { domain: 'pvc.elido-srv.com', labelKey: 'domainLink1', providerKey: 'providerCloudflare' },
  { domain: 'pvc-videocall.b-cdn.net', labelKey: 'domainLink2', providerKey: 'providerBunny' },
];
