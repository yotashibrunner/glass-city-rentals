'use strict';

/*
 * Operator PWA service worker.
 *
 * Scope: /operator/ (served with Service-Worker-Allowed: /operator/).
 *
 * Strategy:
 *  - App shell (html/css/js/icons/manifest): cache-first, so the app opens
 *    instantly and works offline once installed.
 *  - API calls (/api/*): never cached — always go to the network so the
 *    operator never sees stale bookings. Auth state lives in localStorage,
 *    not here.
 *
 * Bump CACHE_VERSION whenever a shell file changes to force a refresh.
 */

const CACHE_VERSION = 'gc-operator-v1';

// Precache the shell so the app is installable and works offline.
const SHELL = [
  '/operator/',
  '/operator/index.html',
  '/operator/css/app.css',
  '/operator/js/app.js',
  '/operator/js/api.js',
  '/operator/manifest.json',
  '/operator/icons/icon-192.png',
  '/operator/icons/icon-512.png',
  '/operator/icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API traffic — the operator must always see live data.
  if (url.pathname.startsWith('/api/')) return;

  // Only manage our own scope.
  if (!url.pathname.startsWith('/operator')) return;

  // Cache-first for the shell, falling back to network and caching new GETs.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached: fall back to the app shell for navigations.
          if (request.mode === 'navigate') return caches.match('/operator/index.html');
          return Response.error();
        });
    })
  );
});
