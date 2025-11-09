import Database from "better-sqlite3";
import path from "node:path";

import { getCachedValue } from "./cache";

const databasePath = process.env.SVITLO_DB_PATH
  ? path.resolve(process.env.SVITLO_DB_PATH)
  : path.resolve(process.cwd(), "../data", "svitlo.db");

console.log("databasePath", databasePath);

const db = new Database(databasePath, {
  fileMustExist: true,
  readonly: true,
});

type ScheduleRow = {
  schedule_date: string;
  outages_json: string;
};

type ActualOutageRow = {
  start_ts: number;
  end_ts: number | null;
};

const schedulesStatement = db.prepare(
  "SELECT schedule_date, outages_json FROM schedules ORDER BY schedule_date"
);

const outagesStatement = db.prepare(
  "SELECT start_ts, end_ts FROM outages ORDER BY start_ts"
);

const DEFAULT_CACHE_TTL_MS = 30_000;
const SCHEDULES_CACHE_KEY = "schedules";
const ACTUAL_OUTAGES_CACHE_KEY = "actual_outages";

export function getSchedules(ttlMs = DEFAULT_CACHE_TTL_MS): ScheduleRow[] {
  return getCachedValue(
    SCHEDULES_CACHE_KEY,
    ttlMs,
    () => schedulesStatement.all() as ScheduleRow[]
  );
}

export function getActualOutages(ttlMs = DEFAULT_CACHE_TTL_MS): ActualOutageRow[] {
  return getCachedValue(
    ACTUAL_OUTAGES_CACHE_KEY,
    ttlMs,
    () => outagesStatement.all() as ActualOutageRow[]
  );
}

export type { ScheduleRow, ActualOutageRow };


