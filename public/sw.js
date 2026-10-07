// Keeps the app shell available offline so saved scripts (stored in the
// browser) can be opened with no signal. Network first, so updates show up
// right away; the cache is only the fallback. API calls are never cached.
const CACHE = "humanual-shell-v1";
const SHELL = ["/", "/styles.css", "/app.js", "/favicon.svg", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request.mode === "navigate" ? "/" : request, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(request.mode === "navigate" ? "/" : request)) ?? Response.error()),
  );
});
