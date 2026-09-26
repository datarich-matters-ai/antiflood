// Offline support: app shell is cache-first, water data is network-first so
// people still see the last known levels when the signal drops.
const CACHE = "antiflood-v7";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "icon.svg", "icon-192.png", "vendor/leaflet.css", "vendor/leaflet.js",
  "vendor/images/marker-icon.png", "vendor/images/marker-icon-2x.png", "vendor/images/marker-shadow.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname.endsWith("basemaps.cartocdn.com") || url.hostname.endsWith("arcgisonline.com")
    || url.hostname.endsWith("nominatim.openstreetmap.org") || url.hostname.endsWith("google.com")
    || url.hostname.endsWith("rainviewer.com") || url.hostname.endsWith("earthdata.nasa.gov")
    || url.hostname.endsWith("open-meteo.com")) return; // don't hoard map tiles

  const networkFirst = url.pathname.includes("/data/") || req.mode === "navigate"
    || /\.(js|css)$/.test(url.pathname) && !url.pathname.includes("/vendor/");
  if (networkFirst) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
  } else {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
