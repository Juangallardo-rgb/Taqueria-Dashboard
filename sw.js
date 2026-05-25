// ======================================================
// DENIX SERVICE WORKER - PUSH NOTIFICATIONS
// ======================================================

// Activa inmediatamente la nueva versión del Service Worker
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Toma control inmediato de la PWA al actualizarse
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Recibir notificación push aunque la app esté cerrada
self.addEventListener('push', (event) => {

  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      body: event.data ? event.data.text() : 'Tienes un nuevo pedido.'
    };
  }

  const title = data.title || '🔔 Nuevo pedido';

  const options = {
    body: data.body || 'Tienes una nueva orden pendiente.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',

    // Permite identificar la orden al tocar la notificación
    data: {
      url: data.url || '/',
      orderId: data.orderId || null
    },

    // Evita notificaciones duplicadas para la misma orden
    tag: data.tag || (data.orderId ? `pedido-${data.orderId}` : 'denix-nuevo-pedido'),

    // Si llega otra actualización de la misma orden, vuelve a notificar
    renotify: true,

    // En dispositivos compatibles, intenta mantener visible el aviso
    requireInteraction: true,

    // Vibración en dispositivos compatibles
    vibrate: [300, 100, 300, 100, 500]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Abrir o enfocar Denix cuando tocan la notificación
self.addEventListener('notificationclick', (event) => {

  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then((clientList) => {

      // Si Denix ya está abierto, lo enfocamos
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(urlToOpen);
          return client.focus();
        }
      }

      // Si está cerrado, lo abrimos
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }

      return null;
    })
  );
});