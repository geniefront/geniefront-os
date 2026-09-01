const CACHE_NAME = 'gf-kiosk-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/brand/geniefront-icon.svg',
  '/brand/geniefront-favicon.svg',
  '/brand/geniefront-app-icon-180.png',
  '/brand/geniefront-app-icon-192.png',
  '/brand/geniefront-app-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只缓存本站静态资源；严禁让设备令牌或任何 API 响应进入 Cache Storage。
  if (url.origin !== self.location.origin || url.pathname.startsWith('/v1/')
      || url.pathname.startsWith('/public/') || event.request.method !== 'GET') {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => response.ok ? response : Promise.reject(new Error('navigation failed')))
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 针对静态资源：Stale-While-Revalidate 模式
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
