import { listSubscriptions, removeSubscriptionByEndpoint } from "./pushDb";
import type {
  NotificationPreferences,
  PushCategory,
  ReminderLeadMinutes,
} from "./notificationPreferences";

type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  category?: PushCategory;
  reminderLeadMinutes?: ReminderLeadMinutes | null;
};

let configured = false;
function ensureConfigured() {
  if (configured) return;
  // Use require to avoid type issues if @types are missing
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const webpush = require("web-push") as typeof import("web-push");

  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  if (!publicKey || !privateKey) {
    console.warn("VAPID keys are not set; push notifications disabled");
    configured = true;
    // Mark as configured to avoid repeated warnings
    return;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

function shouldDeliver(
  message: PushMessage,
  preferences: NotificationPreferences
): boolean {
  if (!message.category) {
    return true;
  }

  switch (message.category) {
    case "actual":
      return preferences.actualEvents;
    case "schedule_change":
      return preferences.scheduleChanges;
    case "reminder":
      if (!preferences.reminders.enabled) {
        return false;
      }
      if (!message.reminderLeadMinutes) {
        return preferences.reminders.leadMinutes.length > 0;
      }
      return preferences.reminders.leadMinutes.includes(message.reminderLeadMinutes);
    default:
      return true;
  }
}

export async function sendPushToAll(
  message: PushMessage
): Promise<{ sent: number; failed: number }> {
  ensureConfigured();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const webpush = require("web-push") as typeof import("web-push");

  const subs = listSubscriptions();
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      if (!shouldDeliver(message, sub.preferences)) {
        return;
      }

      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          } as any,
          JSON.stringify({
            title: message.title,
            body: message.body,
            data: {
              ...(message.data ?? {}),
              category: message.category,
              reminderLeadMinutes: message.reminderLeadMinutes ?? undefined,
            },
          })
        );
        sent += 1;
      } catch (error: any) {
        failed += 1;
        const status: number | undefined = error?.statusCode ?? error?.status;
        if (status === 404 || status === 410) {
          // Subscription no longer valid; remove
          removeSubscriptionByEndpoint(sub.endpoint);
        } else {
          console.error("push send error", status, error?.message);
        }
      }
    })
  );

  return { sent, failed };
}

export type { PushMessage };


