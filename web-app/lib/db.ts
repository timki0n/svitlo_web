import Database from "better-sqlite3";
import path from "node:path";

import { getCachedValue } from "./cache";

const USE_MOCK_DATA = process.env.SVITLO_USE_MOCK_DATA === "1";

const databasePath = process.env.SVITLO_DB_PATH
  ? path.resolve(process.env.SVITLO_DB_PATH)
  : path.resolve(process.cwd(), "../data", "svitlo.db");

console.log(
  "databasePath",
  databasePath,
  USE_MOCK_DATA ? "(mock data mode — sqlite не використовується)" : ""
);

const db = USE_MOCK_DATA
  ? null
  : new Database(databasePath, {
      fileMustExist: true,
      readonly: true,
    });

type ScheduleRow = {
  schedule_date: string;
  status: string | null;
  outages_json: string;
};

type ActualOutageRow = {
  start_ts: number;
  end_ts: number | null;
};

const schedulesStatement = db
  ? db.prepare("SELECT schedule_date, status, outages_json FROM schedules ORDER BY schedule_date")
  : null;

const outagesStatement = db
  ? db.prepare("SELECT start_ts, end_ts FROM outages ORDER BY start_ts")
  : null;

const { schedules: MOCK_SCHEDULES, outages: MOCK_OUTAGES } = createMockData();

const DEFAULT_CACHE_TTL_MS = 30_000;
const SCHEDULES_CACHE_KEY = "schedules";
const ACTUAL_OUTAGES_CACHE_KEY = "actual_outages";

export function getSchedules(ttlMs = DEFAULT_CACHE_TTL_MS): ScheduleRow[] {
  if (USE_MOCK_DATA) {
    return MOCK_SCHEDULES.map((row) => ({ ...row }));
  }

  if (!schedulesStatement) {
    throw new Error("schedulesStatement не ініціалізований");
  }

  return getCachedValue(
    SCHEDULES_CACHE_KEY,
    ttlMs,
    () => schedulesStatement.all() as ScheduleRow[]
  );
}

export function getActualOutages(ttlMs = DEFAULT_CACHE_TTL_MS): ActualOutageRow[] {
  if (USE_MOCK_DATA) {
    return MOCK_OUTAGES.map((row) => ({ ...row }));
  }

  if (!outagesStatement) {
    throw new Error("outagesStatement не ініціалізований");
  }

  return getCachedValue(
    ACTUAL_OUTAGES_CACHE_KEY,
    ttlMs,
    () => outagesStatement.all() as ActualOutageRow[]
  );
}

export type { ScheduleRow, ActualOutageRow };

function createMockData(): {
  schedules: ScheduleRow[];
  outages: ActualOutageRow[];
} {
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const dayAfterTomorrow = addDays(today, 2);

  const mockSchedules: ScheduleRow[] = [
    {
      schedule_date: formatDateKey(today),
      status: "EmergencyShutdowns",
      outages_json: JSON.stringify([]),
    },
    {
      schedule_date: formatDateKey(tomorrow),
      status: "ScheduleApplies",
      outages_json: JSON.stringify([
        {
          start: createDateWithTime(tomorrow, 6, 0).toISOString(),
          end: createDateWithTime(tomorrow, 9, 0).toISOString(),
          type: "Definite",
        },
        {
          start: createDateWithTime(tomorrow, 18, 0).toISOString(),
          end: createDateWithTime(tomorrow, 20, 30).toISOString(),
          type: "Possible",
        },
      ]),
    },
    {
      schedule_date: formatDateKey(dayAfterTomorrow),
      status: "ScheduleApplies",
      outages_json: JSON.stringify([
        {
          start: createDateWithTime(dayAfterTomorrow, 3, 30).toISOString(),
          end: createDateWithTime(dayAfterTomorrow, 5, 0).toISOString(),
          type: "Definite",
        },
      ]),
    },
  ];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const mockOutages: ActualOutageRow[] = [
    {
      start_ts: nowSeconds - 4 * 60 * 60,
      end_ts: nowSeconds - 3 * 60 * 60,
    },
  ];

  return {
    schedules: mockSchedules,
    outages: mockOutages,
  };
}

function startOfDay(date: Date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function addDays(date: Date, amount: number) {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + amount);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function createDateWithTime(base: Date, hours: number, minutes: number) {
  const clone = new Date(base);
  clone.setHours(hours, minutes, 0, 0);
  return clone;
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");

  return `${year}-${month}-${day}`;
}


