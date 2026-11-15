/* PClinic Pro service worker: app shell only.
 *
 * - Never touches anything cross-origin (Firebase sign-in, Firestore sync,
 *   Google, EmailJS), so sign-in and sync always go straight to the network.
 * - Patient data is NOT stored here. It lives in the encrypted local store.
 * - Pages are fetched network-first, so a new deploy shows up on the next
 *   load; the cached copy is only the offline fallback.
 * Bump CACHE when the list of shell files changes.
 */
var CACHE = 'pclinic-shell-v1';
var SHELL = [
  'index.html', 'manifest.webmanifest', 'logo.png',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'vendor/email.min.js', 'vendor/capacitor-filesystem.js'
];
function abs(path) { return new URL(path, self.location).href; }

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (path) {
        return fetch(new Request(abs(path), { cache: 'reload' })).then(function (res) {
          if (res.ok) return cache.put(abs(path), res);
        }).catch(function () { /* offline during install: skip this file */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                             .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // leave Firebase / Google / EmailJS alone

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(abs('index.html'), copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(abs('index.html'));                 // offline: open the app from the cache
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || fresh;
    })
  );
});
