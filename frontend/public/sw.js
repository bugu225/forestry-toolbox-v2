const SW_VERSION = "v8";
const CACHE_PREFIX = "ftb2";
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${SW_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}-static-${SW_VERSION}`;
const API_CACHE = `${CACHE_PREFIX}-api-${SW_VERSION}`;
const IMAGE_CACHE = `${CACHE_PREFIX}-img-${SW_VERSION}`;
const ALL_CACHES = [SHELL_CACHE, STATIC_CACHE, API_CACHE, IMAGE_CACHE];

const SHELL_URLS = ["/"];

const MAX_API_ENTRIES = 80;
const MAX_IMAGE_ENTRIES = 60;
const MAX_STATIC_ENTRIES = 120;
const API_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const IMAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const STATIC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith(`${CACHE_PREFIX}-`) && !ALL_CACHES.includes(n))
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req, API_CACHE, MAX_API_ENTRIES, API_MAX_AGE_MS));
    return;
  }

  if (accept.includes("text/html")) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE, MAX_IMAGE_ENTRIES, IMAGE_MAX_AGE_MS));
    return;
  }

  if (/\.(?:js|css|woff2?|ttf|eot|wasm)$/i.test(url.pathname) || url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req, STATIC_CACHE, MAX_STATIC_ENTRIES, STATIC_MAX_AGE_MS));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

async function cacheFirst(request, cacheName, maxEntries, maxAgeMs) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    const dateHeader = cached.headers.get("sw-cache-date");
    if (dateHeader && Date.now() - Number(dateHeader) > maxAgeMs) {
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const headers = new Headers(res.headers);
            headers.set("sw-cache-date", String(Date.now()));
            res
              .clone()
              .blob()
              .then((body) => cache.put(request, new Response(body, { status: res.status, statusText: res.statusText, headers })));
          }
        })
        .catch(() => {});
    }
    return cached;
  }
  try {
    const res = await fetch(request);
    if (!res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set("sw-cache-date", String(Date.now()));
    const wrapped = new Response(await res.clone().blob(), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
    await cache.put(request, wrapped);
    await trimCache(cacheName, maxEntries);
    return res;
  } catch {
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function networkFirst(request, cacheName, maxEntries, maxAgeMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set("sw-cache-date", String(Date.now()));
      const wrapped = new Response(await res.clone().blob(), {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
      await cache.put(request, wrapped);
      await trimCache(cacheName, maxEntries);
    }
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const dateHeader = cached.headers.get("sw-cache-date");
      if (!dateHeader || Date.now() - Number(dateHeader) <= maxAgeMs) {
        return cached;
      }
    }
    return new Response(
      JSON.stringify({ error: true, offline: true, message: "No network and no cache" }),
      { status: 503, statusText: "Offline", headers: { "Content-Type": "application/json" } }
    );
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((res) => {
      if (res.ok) {
        cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => {
      if (cached) return cached;
      return caches.match("/");
    });
  return cached || fetchPromise;
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.length - maxEntries;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}
