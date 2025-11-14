import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { broadcast } from "@/lib/events";
import { sendPushToAll } from "@/lib/push";
import type { PushCategory, ReminderLeadMinutes } from "@/lib/notificationPreferences";
import { REMINDER_LEAD_MINUTES } from "@/lib/notificationPreferences";

type NotifyPayload = {
  type: "schedule_updated" | "power_outage_started" | "power_restored" | "custom" | "reminder";
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  category?: PushCategory;
  reminderLeadMinutes?: number;
};

const TOKEN = process.env.NOTIFY_BOT_TOKEN || "";

console.log("NOTIFY_BOT_TOKEN", process.env.NOTIFY_BOT_TOKEN);

export async function POST(req: Request) {
  const token = req.headers.get("x-bot-token") || "";
  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let payload: NotifyPayload;
  try {
    payload = (await req.json()) as NotifyPayload;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Invalidate relevant caches via Next tags
  const tagsToRevalidate = new Set<string>();
  switch (payload.type) {
    case "schedule_updated":
      tagsToRevalidate.add("schedules");
      break;
    case "power_outage_started":
    case "power_restored":
      tagsToRevalidate.add("actual_outages");
      break;
    default:
      break;
  }
  await Promise.all(
    Array.from(tagsToRevalidate).map(async (tag) => {
      try {
        await revalidateTag(tag, "notify-api");
      } catch (error) {
        console.error("revalidateTag error", tag, error);
      }
    })
  );

  // Broadcast to active tabs
  broadcast(payload);

  const category = resolveCategory(payload);
  const reminderLeadMinutes = normalizeReminderLead(payload.reminderLeadMinutes);

  // Send Web Push notifications (best-effort)
  try {
    await sendPushToAll({
      title: payload.title ?? "4U Світло",
      body: payload.body ?? "",
      data: {
        ...(payload.data ?? {}),
        type: payload.type,
        category,
        reminderLeadMinutes: reminderLeadMinutes ?? undefined,
      },
      category,
      reminderLeadMinutes: reminderLeadMinutes ?? undefined,
    });
  } catch (error) {
    // do not fail the request if push sending fails
    console.error("notify push error", error);
  }

  return NextResponse.json({ ok: true });
}

function resolveCategory(payload: NotifyPayload): PushCategory | undefined {
  if (payload.category) {
    return payload.category;
  }
  switch (payload.type) {
    case "power_outage_started":
    case "power_restored":
      return "actual";
    case "schedule_updated":
      return "schedule_change";
    case "reminder":
      return "reminder";
    default:
      return undefined;
  }
}

function normalizeReminderLead(value: number | undefined): ReminderLeadMinutes | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return REMINDER_LEAD_MINUTES.includes(value as ReminderLeadMinutes)
    ? (value as ReminderLeadMinutes)
    : undefined;
}



