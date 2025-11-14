import Database from "better-sqlite3";
import path from "node:path";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferences,
  NotificationPreferencesPatch,
  applyPreferencesPatch,
  normalizePreferences,
} from "./notificationPreferences";

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  updated_at: number;
  preferences_json: string;
};

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  updated_at: number;
  preferences: NotificationPreferences;
};

let db: any | null = null;
const DEFAULT_PREFS_JSON = JSON.stringify(DEFAULT_NOTIFICATION_PREFERENCES);

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
      preferences_json TEXT NOT NULL DEFAULT '${DEFAULT_PREFS_JSON}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureMigrations(db);
  return db;
}

function ensureMigrations(database: any) {
  const columns = database.prepare("PRAGMA table_info(subscriptions);").all();
  const columnNames = new Set(columns.map((column: { name: string }) => column.name));

  if (!columnNames.has("preferences_json")) {
    database.exec(`
      ALTER TABLE subscriptions
      ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '${DEFAULT_PREFS_JSON}';
    `);
  }

  if (!columnNames.has("updated_at")) {
    database.exec(`
      ALTER TABLE subscriptions
      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'));
    `);
  }
}

function rowToSubscription(row: SubscriptionRow): StoredSubscription {
  let parsed: unknown;
  try {
    parsed = row.preferences_json ? JSON.parse(row.preferences_json) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    created_at: row.created_at,
    updated_at: row.updated_at,
    preferences: normalizePreferences(parsed),
  };
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
  const nowEpoch = Math.floor(Date.now() / 1000);

  const database = ensureDb();
  const stmt = database.prepare(`
    INSERT INTO subscriptions (id, endpoint, p256dh, auth, preferences_json, created_at, updated_at)
    VALUES (@id, @endpoint, @p256dh, @auth, @preferences_json, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      endpoint=excluded.endpoint,
      p256dh=excluded.p256dh,
      auth=excluded.auth,
      updated_at=excluded.updated_at
  `);
  stmt.run({
    id,
    endpoint,
    p256dh,
    auth,
    preferences_json: DEFAULT_PREFS_JSON,
    created_at: nowEpoch,
    updated_at: nowEpoch,
  });

  return {
    id,
    endpoint,
    p256dh,
    auth,
    created_at: nowEpoch,
    updated_at: nowEpoch,
    preferences: normalizePreferences(DEFAULT_NOTIFICATION_PREFERENCES),
  };
}

export function removeSubscriptionByEndpoint(endpoint: string): boolean {
  const database = ensureDb();
  const stmt = database.prepare(`DELETE FROM subscriptions WHERE endpoint = ?`);
  const info = stmt.run(endpoint);
  return (info.changes ?? 0) > 0;
}

export function listSubscriptions(): StoredSubscription[] {
  const database = ensureDb();
  const stmt = database.prepare(
    `SELECT id, endpoint, p256dh, auth, created_at, updated_at, preferences_json FROM subscriptions`
  );
  return (stmt.all() as SubscriptionRow[]).map(rowToSubscription);
}

function getSubscriptionRowByEndpoint(endpoint: string): SubscriptionRow | null {
  const database = ensureDb();
  const stmt = database.prepare(
    `SELECT id, endpoint, p256dh, auth, created_at, updated_at, preferences_json FROM subscriptions WHERE endpoint = ?`
  );
  const row = stmt.get(endpoint) as SubscriptionRow | undefined;
  return row ?? null;
}

export function getPreferencesByEndpoint(endpoint: string): NotificationPreferences {
  if (!endpoint) {
    throw new Error("endpoint_required");
  }
  const row = getSubscriptionRowByEndpoint(endpoint);
  if (!row) {
    throw new Error("subscription_not_found");
  }
  return rowToSubscription(row).preferences;
}

export function updatePreferencesForEndpoint(
  endpoint: string,
  patch: NotificationPreferencesPatch
): NotificationPreferences {
  if (!endpoint) {
    throw new Error("endpoint_required");
  }
  const database = ensureDb();
  const row = getSubscriptionRowByEndpoint(endpoint);
  if (!row) {
    throw new Error("subscription_not_found");
  }
  const current = rowToSubscription(row).preferences;
  const merged = applyPreferencesPatch(current, patch);
  const stmt = database.prepare(
    `UPDATE subscriptions SET preferences_json = @json, updated_at = @updated WHERE endpoint = @endpoint`
  );
  stmt.run({
    json: JSON.stringify(merged),
    updated: Math.floor(Date.now() / 1000),
    endpoint,
  });
  return merged;
}

export type { StoredSubscription };


