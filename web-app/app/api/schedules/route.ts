import { NextResponse } from "next/server";

import { getSchedules } from "@/lib/db";

export function GET() {
  try {
    const data = getSchedules();

    return NextResponse.json({ data });
  } catch (error) {
    console.error("Не вдалося отримати розклад з SQLite:", error);

    return NextResponse.json(
      { error: "Внутрішня помилка під час читання бази даних." },
      { status: 500 }
    );
  }
}





