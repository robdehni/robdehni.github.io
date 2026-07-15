// FieldIQ Service Worker — v2
// Cache version must be bumped on every real deployment. Previously
// hardcoded as a fixed string that never changed between deployments, so
// the activate handler's own cleanup logic had nothing to ever find and
// delete.
var CACHE = 'fieldiq-shell-v4';

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

// Every network attempt below is bounded — if a request stalls (opens but
// never completes or errors, a real mobile-network failure mode), it is
// aborted after 8 seconds and treated as a failure, falling through to
// cache. Without this, a stalled fetch() inside respondWith() leaves the
// page's own resource request hanging indefinitely.
function fetchWithTimeout(request, ms) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, ms || 8000);
  return fetch(request, { signal: controller.signal }).finally(function() { clearTimeout(timer); });
}

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

  // Network-first, not cache-first. The previous version returned any
  // cached copy immediately whenever one existed and only used the
  // network to quietly refresh that cache for next time — meaning a
  // deployed change (a bug fix, a UI update) could sit unseen behind a
  // stale cached page until a hard refresh forced the browser past it.
  // This always tries the real network first; the cache is now only a
  // fallback for when the network genuinely fails.
  e.respondWith(
    fetchWithTimeout(e.request)
      .then(function(networkRes) {
        if (networkRes && networkRes.status === 200) {
          var copy = networkRes.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, copy);
          });
        }
        return networkRes;
      })
      .catch(function() {
        return caches.match(e.request);
      })
  );

});
