/**
 * Optional external Cloudflare Worker relay override.
 * Leave `relayUrl` empty to automatically use the same origin (recommended when
 * hosted directly on `https://marioparty3web.johansans999.workers.dev` or `localhost:8080`).
 */
window.MP3_RELAY_CONFIG = {
  relayUrl: "",
  defaultCore: "mupen64plus_next",
};
