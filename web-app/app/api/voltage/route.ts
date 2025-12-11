import { NextResponse } from "next/server";
import { getVoltageHistory } from "@/lib/homeassistant";

export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await getVoltageHistory();

  if (!stats) {
    return NextResponse.json({ data: null, error: "no-data" }, { status: 200, headers: noStore() });
  }

  return NextResponse.json({ data: stats }, { status: 200, headers: noStore() });
}

function noStore() {
  return {
    "Cache-Control": "no-store, max-age=0",
  };
}

