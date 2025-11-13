import { NextResponse } from "next/server";
import { clearCache } from "@/lib/cache";
import { broadcast } from "@/lib/events";
import { sendPushToAll } from "@/lib/push";

type TestPayload = {
  type?: string;
  title?: string;
  body?: string;
  data?: unknown;
};

const TEST_MODE = process.env.NOTIFY_TEST_MODE === "1";
const TEST_TOKEN = process.env.NOTIFY_TEST_TOKEN || "";

function authorize(req: Request): boolean {
  if (!TEST_MODE) return false;
  if (!TEST_TOKEN) return true;
  const header = req.headers.get("x-test-token") || "";
  return header === TEST_TOKEN;
}

function resolveClearTargets(clearParam: string | null): string[] {
  switch ((clearParam || "").toLowerCase()) {
    case "all":
      return ["schedules", "actual_outages"];
    case "schedules":
      return ["schedules"];
    case "actual_outages":
      return ["actual_outages"];
    case "none":
    case "":
    default:
      return [];
  }
}

async function handle(payload: TestPayload, clearParam: string | null) {
  const clearTargets = resolveClearTargets(clearParam);
  for (const key of clearTargets) {
    clearCache(key);
  }

  const enriched = {
    type: payload.type || "custom",
    title: payload.title || "Тестова нотифікація",
    body: payload.body || "Це тестове повідомлення від 4U Світло",
    data: payload.data ?? {},
  };

  broadcast(enriched);

  const pushResult = await sendPushToAll({
    title: enriched.title!,
    body: enriched.body!,
    data: { ...(enriched.data as any), type: enriched.type },
  });

  return {
    ok: true,
    cleared: clearTargets,
    pushed: pushResult,
    event: enriched,
  };
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || undefined;
  const title = url.searchParams.get("title") || undefined;
  const body = url.searchParams.get("body") || undefined;
  const clear = url.searchParams.get("clear");

  const result = await handle({ type, title, body }, clear);
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: TestPayload & { clear?: string } = {};
  try {
    body = (await req.json()) as any;
  } catch {
    // ignore, will use defaults
  }
  const result = await handle(
    { type: body.type, title: body.title, body: body.body, data: body.data },
    body.clear ?? null
  );
  return NextResponse.json(result);
}


