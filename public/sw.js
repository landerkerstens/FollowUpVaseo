/* FollowUp Vaseo – zorgt dat de app zonder bereik opent. Bevat alleen de programmabestanden, geen klantgegevens.
 * Altijd eerst het netwerk, zodat je de nieuwste versie krijgt; de kopie is enkel de terugval. */
const CACHE = "followup-shell-v1";
const SHELL = ["./", "index.html", "styles.css", "core.js", "stats.js", "storage.js", "app.js", "config.js", "logo.svg", "favicon.svg", "vendor/leaflet.js", "vendor/leaflet.css", "vendor/supabase.js"];
const TIMEOUT = 5000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    });
    if (!cached) return network;
    // Traag netwerk: niet blijven wachten als er een kopie is.
    const slow = new Promise((resolve) => setTimeout(() => resolve(cached), TIMEOUT));
    return Promise.race([network.catch(() => cached), slow]);
  })());
});
