self.addEventListener('push', (event) => {
  const payload = extractPayload(event);
  const message = buildNotification(payload);
  event.waitUntil(self.registration.showNotification(message.title, message.options));
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

function extractPayload(event) {
  let raw = {};
  try {
    raw = event.data ? event.data.json() : {};
  } catch (e) {
    raw = {};
  }
  const data = (raw && typeof raw.data === 'object' && raw.data !== null) ? raw.data : {};
  const type = raw.type || data.type || null;
  const category = data.category || mapTypeToCategory(type);
  const reminderLeadMinutes =
    data.reminderLeadMinutes ?? raw.reminderLeadMinutes ?? null;

  return {
    title: raw.title || '4U Світло',
    body: raw.body || '',
    data,
    type,
    category,
    reminderLeadMinutes,
  };
}

function mapTypeToCategory(type) {
  switch (type) {
    case 'power_outage_started':
    case 'power_restored':
      return 'actual';
    case 'schedule_updated':
      return 'schedule_change';
    case 'reminder':
      return 'reminder';
    default:
      return null;
  }
}

function buildNotification(payload) {
  const data = payload.data || {};
  const category = payload.category;
  const networkState = data.networkState || null;
  const reminder = extractReminder(data);
  let body = payload.body || '';

  if (category === 'reminder' && reminder) {
    if (reminder.kind === 'outage') {
      const durationLabel = reminder.durationMinutes
        ? formatDuration(reminder.durationMinutes)
        : '';
      const endTimeLabel = reminder.endISO ? formatTime(reminder.endISO) : '';
      body = `Світло є, але нагадую: за ${formatLead(reminder.leadMinutes)} буде відключення${
        endTimeLabel ? ` до ${endTimeLabel}` : ''
      }${durationLabel ? ` (${durationLabel})` : ''}.`;
    } else if (reminder.kind === 'restore') {
      body = `Світла немає, але за графіком має з'явитися через ${formatLead(
        reminder.leadMinutes
      )}.`;
    }
  } else if (!body && networkState) {
    body =
      networkState === 'off'
        ? 'Світла немає. Стежимо за графіком.'
        : 'Світло є. Стежимо за графіком.';
  }

  const tag =
    data.tag ||
    (category === 'actual' || category === 'reminder' ? 'power-status' : undefined);
  const isPowerEvent = category === 'actual' || category === 'reminder';
  const outageIcon = '/icons/icon-192-off.png';
  const icon = networkState === 'off' ? outageIcon : '/icons/icon-192.png';

  return {
    title: payload.title,
    options: {
      body,
      icon: '/icons/icon-192.png',
      badge: isPowerEvent ? icon : undefined,
      data,
      tag,
      renotify: Boolean(tag),
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200],
    },
  };
}

function extractReminder(data) {
  if (!data || typeof data.reminder !== 'object' || data.reminder === null) {
    return null;
  }
  const reminder = data.reminder;
  const kind = reminder.kind === 'restore' ? 'restore' : 'outage';
  const lead = typeof reminder.leadMinutes === 'number' ? reminder.leadMinutes : null;
  if (!lead) {
    return null;
  }
  return {
    kind,
    leadMinutes: lead,
    endISO: reminder.endISO || null,
    durationMinutes: reminder.durationMinutes || null,
  };
}

function formatLead(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 год' : `${hours} год`;
  }
  return `${minutes} хв`;
}

function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes)));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours} год`);
  }
  if (remainder > 0) {
    parts.push(`${remainder} хв`);
  }
  return parts.join(' ') || 'менше 1 хв';
}

function formatTime(isoString) {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

