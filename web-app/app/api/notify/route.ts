import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { broadcast } from "@/lib/events";
import { sendPushToAll } from "@/lib/push";

type NotifyPayload = {
  type: "schedule_updated" | "power_outage_started" | "power_restored" | "custom";
  title?: string;
  body?: string;
  data?: unknown;
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
        await revalidateTag(tag);
      } catch (error) {
        console.error("revalidateTag error", tag, error);
      }
    })
  );

  // Broadcast to active tabs
  broadcast(payload);

  // Send Web Push notifications (best-effort)
  try {
    await sendPushToAll({
      title: payload.title ?? "4U Світло",
      body: payload.body ?? "",
      data: { ...(payload.data ?? {}), type: payload.type },
    });
  } catch (error) {
    // do not fail the request if push sending fails
    console.error("notify push error", error);
  }

  return NextResponse.json({ ok: true });
}


