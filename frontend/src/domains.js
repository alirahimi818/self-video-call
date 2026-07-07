// Same app, reachable through different ingress paths (direct / Cloudflare /
// BunnyCDN) — if one is blocked or throttled, another might not be.
// labelKey is an i18n key (see i18n/en.js, i18n/fa.js).
export const DOMAINS = [
  { domain: 'pvc.ali-rahimi.me', labelKey: 'domainMain' },
  { domain: 'pvc.elido-srv.com', labelKey: 'domainLink1' },
  { domain: 'pvc-videocall.b-cdn.net', labelKey: 'domainLink2' },
];
