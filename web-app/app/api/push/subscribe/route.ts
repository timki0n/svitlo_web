import { NextResponse } from "next/server";
import { upsertSubscriptionFromRaw } from "@/lib/pushDb";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const saved = upsertSubscriptionFromRaw(body);
    return NextResponse.json({ ok: true, id: saved.id });
  } catch (error) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
}


