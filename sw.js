// FieldIQ Service Worker — v1.1
// Safe shell cache only.
// API/CDN/map/data requests are never intercepted.

var CACHE = 'fieldiq-shell-v3';

var SHELL = [
  '/index.html',
  '/fieldiq.html',
  '/dashboard.html',
  '/fieldiq-log-visit.html',
  '/fieldiq-visit-history.html',
  '/fieldiq-open-actions.html',
  '/fieldiq-calendar.html',
  '/fieldiq-actions.html',
  '/fieldiq-operations.html',
  '/fieldiq-manager-calendar.html',
  '/fieldiq-visits-map.html',
  '/fieldiq-accounts.html',
  '/fieldiq-insights.html',
  '/fieldiq-guide.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png'
];

var NETWORK_ONLY = [
  'fieldiq-proxy.rdehni1979.workers.dev',
  'api.airtable.com',
  'api.openai.com',
  'api.anthropic.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'tile.openstreetmap.org',
  'openstreetmap.org'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return Promise.allSettled(
        SHELL.map(function(url) {
          return cache.add(url).catch(function() {});
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(key) {
            return key !== CACHE;
          })
          .map(function(key) {
            return caches.delete(key);
          })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {

  if (e.request.method !== 'GET') return;

  var url = e.request.url;

  for (var i = 0; i < NETWORK_ONLY.length; i++) {
    if (url.indexOf(NETWORK_ONLY[i]) !== -1) {
      return;
    }
  }

  var requestUrl = new URL(url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  var isNavigation =
    e.request.mode === 'navigate' ||
    requestUrl.pathname === '/' ||
    requestUrl.pathname.endsWith('.html');

  if (!isNavigation) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function(cached) {

      var networkUpdate = fetch(e.request)
        .then(function(networkRes) {

          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE).then(function(cache) {
              cache.put(e.request, networkRes.clone());
            });
          }

          return networkRes;
        })
        .catch(function() {
          return null;
        });

      return cached || networkUpdate;
    })
  );

});
