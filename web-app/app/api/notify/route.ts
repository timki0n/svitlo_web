import { NextResponse } from "next/server";
import { clearCache } from "@/lib/cache";
import { broadcast } from "@/lib/events";
import { sendPushToAll } from "@/lib/push";

type NotifyPayload = {
  type: "schedule_updated" | "power_outage_started" | "power_restored" | "custom";
  title?: string;
  body?: string;
  data?: unknown;
};

const TOKEN = process.env.NOTIFY_BOT_TOKEN || "";

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

  // Invalidate relevant caches
  switch (payload.type) {
    case "schedule_updated":
      clearCache("schedules");
      break;
    case "power_outage_started":
    case "power_restored":
      clearCache("actual_outages");
      break;
    default:
      break;
  }

  // Broadcast to active tabs
  broadcast(payload);

  // Send Web Push notifications (best-effort)
  try {
    await sendPushToAll({
      title: payload.title ?? "4U Світло",
      body: payload.body ?? "",
      data: payload.data ?? {},
    });
  } catch (error) {
    // do not fail the request if push sending fails
    console.error("notify push error", error);
  }

  return NextResponse.json({ ok: true });
}


