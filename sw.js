// Guarda la app y el lector de texto para que funcione sin internet después de la primera vez.
const CACHE = "recibos-v3";
const SHELL = ["./", "index.html", "app.js?v=3", "parser.js?v=3", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const own = url.origin === location.origin;
  if (own) {
    // la app: primero la red (para recibir mejoras), si no hay internet usa la copia guardada
    e.respondWith(fetch(e.request, {cache: "no-cache"}).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
  } else if (/jsdelivr|tessdata|fonts\.(googleapis|gstatic)/.test(url.host + url.pathname)) {
    // lector de texto y fuentes: copia guardada primero
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })));
  }
});
