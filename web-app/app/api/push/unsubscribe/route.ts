import { NextResponse } from "next/server";
import { removeSubscriptionByEndpoint } from "@/lib/pushDb";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const removed = removeSubscriptionByEndpoint(endpoint);
    return NextResponse.json({ ok: true, removed });
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
}


