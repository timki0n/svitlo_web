import asyncio
import datetime as dt
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Sequence


class Database:
    """
    Простий обгортковий клас над SQLite для логування відключень і графіків.
    Всі публічні методи асинхронні та виконують роботу в окремому потоці.
    """

    def __init__(self, path: Path | None = None) -> None:
        db_path_env = os.getenv("DB_PATH")
        if path is None:
            path = Path(db_path_env) if db_path_env else Path("data") / "svitlo.db"

        if not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)

        self._path = path
        self._conn = sqlite3.connect(
            str(self._path),
            check_same_thread=False,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._conn:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA foreign_keys=ON;")
        self._init_schema()

    # ---------- публічне API ----------
    async def log_outage_start(self, start_ts: float) -> int:
        """
        Створює (або оновлює) запис про відключення.
        Повертає ідентифікатор запису про відключення.
        """
        return await asyncio.to_thread(self._log_outage_start_sync, start_ts)

    async def log_outage_end(self, end_ts: float) -> float | None:
        """
        Закриває останнє відключення (end_ts) і повертає start_ts,
        щоб можна було коректно розрахувати тривалість.
        """
        return await asyncio.to_thread(self._log_outage_end_sync, end_ts)

    async def upsert_schedule(
        self,
        date_value: dt.date | dt.datetime | str | None,
        status: str | None,
        outages: Sequence[dict[str, Any]] | None,
        raw_slots: Sequence[Any] | None,
    ) -> None:
        """
        Оновлює або створює поточний графік на конкретну дату.
        """
        await asyncio.to_thread(
            self._upsert_schedule_sync,
            date_value,
            status,
            outages,
            raw_slots,
        )

    async def get_active_outage(self) -> dict[str, Any] | None:
        """
        Повертає останнє відключення без end_ts або None.
        """
        return await asyncio.to_thread(self._get_active_outage_sync)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------- службові методи (тільки sync) ----------
    def _init_schema(self) -> None:
        now = time.time()
        with self._lock, self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS outages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    start_ts REAL NOT NULL,
                    end_ts REAL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schedules (
                    schedule_date TEXT PRIMARY KEY,
                    status TEXT,
                    outages_json TEXT,
                    slots_json TEXT,
                    updated_at REAL NOT NULL
                );
                """
            )
            self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_outages_end_ts
                ON outages(end_ts);
                """
            )
            # Записуємо часову мітку ініціалізації (для порожньої бази)
            self._conn.execute(
                """
                INSERT OR IGNORE INTO schedules (schedule_date, status, outages_json, slots_json, updated_at)
                VALUES ('__init__', NULL, NULL, NULL, ?);
                """,
                (now,),
            )
            self._conn.execute(
                "DELETE FROM schedules WHERE schedule_date = '__init__';"
            )

    def _log_outage_start_sync(self, start_ts: float) -> int:
        now = time.time()
        with self._lock, self._conn:
            row = self._conn.execute(
                """
                SELECT id, start_ts FROM outages
                WHERE end_ts IS NULL
                ORDER BY start_ts DESC
                LIMIT 1;
                """
            ).fetchone()

            if row:
                outage_id = int(row["id"])
                existing_start = float(row["start_ts"])
                if start_ts < existing_start:
                    self._conn.execute(
                        """
                        UPDATE outages
                        SET start_ts = ?, updated_at = ?
                        WHERE id = ?;
                        """,
                        (start_ts, now, outage_id),
                    )
                else:
                    self._conn.execute(
                        """
                        UPDATE outages
                        SET updated_at = ?
                        WHERE id = ?;
                        """,
                        (now, outage_id),
                    )
                return outage_id

            cur = self._conn.execute(
                """
                INSERT INTO outages (start_ts, end_ts, created_at, updated_at)
                VALUES (?, NULL, ?, ?);
                """,
                (start_ts, now, now),
            )
            return int(cur.lastrowid)

    def _log_outage_end_sync(self, end_ts: float) -> float | None:
        now = time.time()
        with self._lock, self._conn:
            row = self._conn.execute(
                """
                SELECT id, start_ts FROM outages
                WHERE end_ts IS NULL
                ORDER BY start_ts DESC
                LIMIT 1;
                """
            ).fetchone()

            if row:
                outage_id = int(row["id"])
                start_ts = float(row["start_ts"])
                self._conn.execute(
                    """
                    UPDATE outages
                    SET end_ts = ?, updated_at = ?
                    WHERE id = ?;
                    """,
                    (end_ts, now, outage_id),
                )
                return start_ts

            # Якщо відкритого відключення немає, логічно створити
            # короткий запис із однаковим start/end.
            self._conn.execute(
                """
                INSERT INTO outages (start_ts, end_ts, created_at, updated_at)
                VALUES (?, ?, ?, ?);
                """,
                (end_ts, end_ts, now, now),
            )
            return None

    def _upsert_schedule_sync(
        self,
        date_value: dt.date | dt.datetime | str | None,
        status: str | None,
        outages: Sequence[dict[str, Any]] | None,
        raw_slots: Sequence[Any] | None,
    ) -> None:
        if date_value is None:
            return

        date_str = self._normalize_date(date_value)
        outages_json = self._serialize_outages(outages or [])
        slots_json = self._serialize_slots(raw_slots or [])
        now = time.time()

        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO schedules (schedule_date, status, outages_json, slots_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(schedule_date) DO UPDATE SET
                    status = excluded.status,
                    outages_json = excluded.outages_json,
                    slots_json = excluded.slots_json,
                    updated_at = excluded.updated_at;
                """,
                (date_str, status, outages_json, slots_json, now),
            )

    def _get_active_outage_sync(self) -> dict[str, Any] | None:
        with self._lock, self._conn:
            row = self._conn.execute(
                """
                SELECT id, start_ts, end_ts, created_at, updated_at
                FROM outages
                WHERE end_ts IS NULL
                ORDER BY start_ts DESC
                LIMIT 1;
                """
            ).fetchone()
            return dict(row) if row else None

    @staticmethod
    def _normalize_date(value: dt.date | dt.datetime | str) -> str:
        if isinstance(value, dt.datetime):
            return value.date().isoformat()
        if isinstance(value, dt.date):
            return value.isoformat()
        return str(value)

    @staticmethod
    def _serialize_outages(outages: Iterable[dict[str, Any]]) -> str:
        normalized: list[dict[str, Any]] = []
        for outage in outages:
            start = outage.get("start")
            end = outage.get("end")
            normalized.append(
                {
                    "start": Database._to_iso(start),
                    "end": Database._to_iso(end),
                    "type": outage.get("type"),
                }
            )
        return json.dumps(normalized, ensure_ascii=True)

    @staticmethod
    def _serialize_slots(slots: Iterable[Any]) -> str:
        normalized: list[dict[str, Any]] = []
        for slot in slots:
            normalized.append(
                {
                    "start_min": getattr(slot, "start_min", None),
                    "end_min": getattr(slot, "end_min", None),
                    "type": getattr(slot, "type", None),
                }
            )
        return json.dumps(normalized, ensure_ascii=True)

    @staticmethod
    def _to_iso(value: Any) -> str | None:
        if value is None:
            return None
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return str(value)


db = Database()

