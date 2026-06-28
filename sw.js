// FieldIQ Service Worker — v1.0
// Caches static HTML shell only.
// NEVER caches Cloudflare Worker API calls or Airtable data.

var CACHE = 'fieldiq-shell-v1';

var SHELL = [
  '/index.html',
  '/fieldiq.html',
  '/fieldiq-log-visit.html',
  '/fieldiq-visit-history.html',
  '/fieldiq-open-actions.html',
  '/fieldiq-calendar.html',
  '/fieldiq-actions.html',
  '/dashboard.html',
  '/fieldiq-visits-map.html',
  '/fieldiq-accounts.html',
  '/fieldiq-insights.html',
  '/fieldiq-guide.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png'
];

// Never cache these origins — always network only
var NETWORK_ONLY = [
  'fieldiq-proxy.rdehni1979.workers.dev',
  'api.airtable.com',
  'api.openai.com',
  'api.anthropic.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'openstreetmap.org'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      // Cache each file individually — failure of one does not block install
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
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Always network: API calls, CDN scripts, tiles — never cache
  for (var i = 0; i < NETWORK_ONLY.length; i++) {
    if (url.indexOf(NETWORK_ONLY[i]) !== -1) {
      return; // let browser handle normally
    }
  }

  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  // Network-first for everything else (HTML pages, manifest, icons)
  e.respondWith(
    fetch(e.request).then(function(networkRes) {
      // Network succeeded — update cache silently
      if (networkRes && networkRes.status === 200) {
        var clone = networkRes.clone();
        caches.open(CACHE).then(function(cache) {
          cache.put(e.request, clone);
        });
      }
      return networkRes;
    }).catch(function() {
      // Network failed — serve from cache if available
      return caches.match(e.request);
    })
  );
});
