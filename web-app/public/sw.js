self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  const title = payload.title || '4U Світло';
  const body = payload.body || '';
  const data = payload.data || {};
  const type = payload.type || data?.type || null;
  // Якщо це подія стану світла, використовуємо спільний tag для заміни попереднього пуша
  const tag =
    (data && data.tag) ||
    (type === 'power_outage_started' || type === 'power_restored' ? 'power-status' : undefined);
  // Іконка: для вимкнення світла — окремий значок, інакше — стандартний
  const icon =
    type === 'power_outage_started' ? '/icons/icon-192-off.png' : '/icons/icon-192.png';
  const isPowerEvent = type === 'power_outage_started' || type === 'power_restored';
  const options = {
    body,
    icon,
    badge: '/icons/icon-192.png',
    data,
    tag,
    renotify: Boolean(tag),
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});


