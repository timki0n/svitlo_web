import Database from "better-sqlite3";
import path from "node:path";

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
};

let db: any | null = null;

function ensureDb() {
  if (db) {
    return db;
  }
  const dbPath = process.env.PUSH_SUBS_DB_PATH
    ? path.resolve(process.env.PUSH_SUBS_DB_PATH)
    : path.resolve(process.cwd(), "../data", "push_subs.db");
  db = new Database(dbPath, { fileMustExist: false, readonly: false });
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function upsertSubscriptionFromRaw(raw: unknown): StoredSubscription {
  const obj = raw as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!obj || typeof obj.endpoint !== "string" || !obj.keys || typeof obj.keys.p256dh !== "string" || typeof obj.keys.auth !== "string") {
    throw new Error("invalid_subscription");
  }
  const endpoint = obj.endpoint;
  const p256dh = obj.keys.p256dh;
  const auth = obj.keys.auth;
  const id = endpoint; // using endpoint as primary id
  const createdAt = Math.floor(Date.now() / 1000);

  const database = ensureDb();
  const stmt = database.prepare(`
    INSERT INTO subscriptions (id, endpoint, p256dh, auth, created_at)
    VALUES (@id, @endpoint, @p256dh, @auth, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      endpoint=excluded.endpoint,
      p256dh=excluded.p256dh,
      auth=excluded.auth
  `);
  stmt.run({ id, endpoint, p256dh, auth, created_at: createdAt });

  return { id, endpoint, p256dh, auth, created_at: createdAt };
}

export function removeSubscriptionByEndpoint(endpoint: string): boolean {
  const database = ensureDb();
  const stmt = database.prepare(`DELETE FROM subscriptions WHERE endpoint = ?`);
  const info = stmt.run(endpoint);
  return (info.changes ?? 0) > 0;
}

export function listSubscriptions(): StoredSubscription[] {
  const database = ensureDb();
  const stmt = database.prepare(`SELECT id, endpoint, p256dh, auth, created_at FROM subscriptions`);
  return stmt.all() as StoredSubscription[];
}

export type { StoredSubscription };


