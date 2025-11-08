import Database from "better-sqlite3";
import path from "node:path";

type ScheduleRow = {
  schedule_date: string;
  outages_json: string;
};

type ActualOutageRow = {
  start_ts: number;
  end_ts: number | null;
};

const databasePath = path.resolve(process.cwd(), "..", "svitlo.db");

const db = new Database(databasePath, {
  fileMustExist: true,
  readonly: true,
});

export function getSchedules(): ScheduleRow[] {
  const statement = db.prepare<ScheduleRow>(
    "SELECT schedule_date, outages_json FROM schedules ORDER BY schedule_date"
  );

  return statement.all();
}

export function getActualOutages(): ActualOutageRow[] {
  const statement = db.prepare<ActualOutageRow>(
    "SELECT start_ts, end_ts FROM outages ORDER BY start_ts"
  );

  return statement.all();
}

export type { ScheduleRow, ActualOutageRow };


