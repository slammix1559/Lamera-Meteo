const CACHE = 'meteo-lamera-v3';
const BASE = self.location.pathname.replace('/sw.js', '');

const STATIC = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-512.png',
];

// ── INSTALL ───────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('open-meteo.com') ||
      url.hostname.includes('geocoding-api') ||
      url.hostname.includes('openweathermap.org') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('fcm.googleapis.com')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }), { headers: { 'Content-Type': 'application/json' } })
    ));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      });
    })
  );
});

// ── PUSH NOTIFICATION (FCM) ───────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { notification: { title: 'Meteo Lamera', body: e.data.text() } }; }

  const { title, body } = payload.notification || {};
  const data = payload.data || {};
  const isExtreme = data.extreme === 'true';

  e.waitUntil(
    self.registration.showNotification(title || 'Meteo Lamera', {
      body:    body || '',
      icon:    BASE + '/icons/icon-192.png',
      badge:   BASE + '/icons/icon-192.png',
      vibrate: isExtreme ? [300, 100, 300, 100, 300] : [200, 100, 200],
      requireInteraction: isExtreme,
      tag:     data.type || 'meteo',
      data:    { url: data.url || 'https://slammix1559.github.io/Lamera-Meteo/' },
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || 'https://slammix1559.github.io/Lamera-Meteo/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('Lamera-Meteo'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
