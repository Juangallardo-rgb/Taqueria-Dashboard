const ADMIN_CACHE = 'denix-admin-shell-v2';
const PUBLIC_SHELL = [
  '/admin/login',
  '/admin/offline.html',
  '/admin/login/assets/login.css',
  '/admin/login/assets/login.js',
  '/admin/pwa.js',
  '/admin/manifest.webmanifest',
  '/admin/icon-192.png',
  '/admin/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(ADMIN_CACHE)
      .then(cache => cache.addAll(PUBLIC_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('denix-admin-shell-') && key !== ADMIN_CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isPublicShellAsset(url) {
  return PUBLIC_SHELL.includes(url.pathname);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/admin/offline.html'))
    );
    return;
  }

  if (isPublicShellAsset(url)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
  }
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: 'Hay una actualización en Denix.' };
  }

  event.waitUntil(self.registration.showNotification(data.title || 'Denix Admin', {
    body: data.body || 'Hay una actualización en Denix.',
    icon: '/admin/icon-192.png',
    badge: '/admin/icon-192.png',
    tag: data.tag || 'denix-admin-update',
    data: { url: data.url?.startsWith('/admin') ? data.url : '/admin/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/admin/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(client => new URL(client.url).pathname.startsWith('/admin'));
        if (existing) return existing.navigate(target).then(client => client.focus());
        return self.clients.openWindow(target);
      })
  );
});
