import Database from "better-sqlite3";
import path from "node:path";

const databasePath = process.env.SVITLO_DB_PATH
  ? path.resolve(process.env.SVITLO_DB_PATH)
  : path.resolve(process.cwd(), "..", "svitlo.db");

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

export function getSchedules(): ScheduleRow[] {
  const statement = db.prepare<any[], ScheduleRow>(
    "SELECT schedule_date, outages_json FROM schedules ORDER BY schedule_date"
  );

  return statement.all();
}

export function getActualOutages(): ActualOutageRow[] {
  const statement = db.prepare<any[], ActualOutageRow>(
    "SELECT start_ts, end_ts FROM outages ORDER BY start_ts"
  );

  return statement.all();
}

export type { ScheduleRow, ActualOutageRow };


