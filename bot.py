import os
import re
import sys
import asyncio
from asyncio.subprocess import PIPE
import logging
import time
import tempfile
import contextlib
import json
import urllib.request
import urllib.error
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Final, Literal

from aiogram import Bot, Dispatcher, Router, types
from aiogram.types import Message
from aiogram.filters import Command, CommandObject

from dotenv import load_dotenv
from udp_listener import UDPListener
from yasno_outages import YasnoOutages
from storage import db



# ───────────────── env / config ─────────────────
load_dotenv()  # підтягуємо .env із поточної директорії

YASNO_GROUP = os.getenv("YASNO_GROUP", "6.2")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_LOG_CHAT_ID = int(os.getenv("ADMIN_LOG_CHAT_ID", "396952666"))
def _parse_chat_targets_env(raw: str | None) -> tuple[tuple[int, int | None], ...]:
    if not raw:
        return tuple()

    targets: list[tuple[int, int | None]] = []
    parts = [part for part in re.split(r"[,\s]+", raw.strip()) if part]
    for part in parts:
        if "_" in part:
            chat_part, thread_part = part.rsplit("_", 1)
            chat_id = int(chat_part)
            thread_id = int(thread_part)
            targets.append((chat_id, thread_id))
        else:
            chat_id = int(part)
            targets.append((chat_id, None))

    return tuple(targets)


ALERT_CHAT_TARGETS: Final[tuple[tuple[int, int | None], ...]] = _parse_chat_targets_env(os.getenv("ALERT_CHAT_ID"))
BLOCKED_CHAT_TARGETS: Final[tuple[tuple[int, int | None], ...]] = _parse_chat_targets_env(os.getenv("BLOCK_ALERT_CHAT_ID"))
UDP_PORT = int(os.getenv("UDP_PORT", "5005"))
DEFAULT_THRESHOLD_SEC = float(os.getenv("THRESHOLD_SEC", "6"))
SCHEDULE_POLL_INTERVAL_SEC = 60
WEB_NOTIFY_URL = os.getenv("WEB_NOTIFY_URL", "http://127.0.0.1:3000/api/notify")
NOTIFY_BOT_TOKEN = os.getenv("NOTIFY_BOT_TOKEN", "")
DEFAULT_SCREENSHOT_SCRIPT = Path(__file__).with_name("scripts").joinpath("render_timeline_screenshot.py")
TIMELINE_SCREENSHOT_SCRIPT = Path(os.getenv("TIMELINE_SCREENSHOT_SCRIPT", str(DEFAULT_SCREENSHOT_SCRIPT)))
TIMELINE_SCREENSHOT_BASE_URL = os.getenv("TIMELINE_SCREENSHOT_BASE_URL", "http://127.0.0.1:3000")
TIMELINE_SCREENSHOT_ENABLED = os.getenv("TIMELINE_SCREENSHOT_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
TIMELINE_SCREENSHOT_PYTHON = os.getenv("TIMELINE_SCREENSHOT_PYTHON") or sys.executable

TZ = ZoneInfo("Europe/Kyiv")

# ───────────────── глобальний стан ─────────────────
router = Router()
listener = UDPListener(port=UDP_PORT)
yasno = YasnoOutages(region_id=25, dso_id=902, group_id=YASNO_GROUP)

threshold_sec = DEFAULT_THRESHOLD_SEC
startup_ts = 0.0
last_today_signature: tuple | None = None
last_tomorrow_status: str | None = None
last_today_date = None
last_tomorrow_date = None
REMINDER_LEADS: Final[tuple[int, ...]] = (10, 20, 30, 60)
REMINDER_TRIGGER_WINDOW_SEC = 45
REMINDER_HISTORY_TTL_SEC = 6 * 3600
reminder_history: dict[str, float] = {}

# ───────────────── helpers ─────────────────
def _is_chat_blocked(chat_id: int, thread_id: int | None) -> bool:
    if not BLOCKED_CHAT_TARGETS:
        return False
    for blocked_chat_id, blocked_thread_id in BLOCKED_CHAT_TARGETS:
        if blocked_chat_id != chat_id:
            continue
        if blocked_thread_id is None:
            if thread_id is None:
                return True
            continue
        if blocked_thread_id == thread_id:
            return True
    return False

async def _skip_if_blocked(message: Message) -> bool:
    """
    Повертає True, якщо команда повинна бути проігнорована через блокування чату.
    Також намагається видалити повідомлення користувача.
    """
    chat = message.chat
    if chat is None:
        return False
    thread_id = message.message_thread_id
    if not _is_chat_blocked(chat.id, thread_id):
        return False
    try:
        await message.delete()
    except Exception as e:
        logging.warning("Не вдалося видалити команду у chat=%s thread=%s: %s", chat.id, thread_id, e)
    return True

def fmt_dt(ts: float) -> str:
    try:
        return datetime.fromtimestamp(ts, tz=TZ).strftime("%Y-%m-%d %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return "невідомо"

def fmt_duration(seconds: float) -> str:
    try:
        seconds = int(seconds)
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        parts = []
        if h: parts.append(f"{h}h")
        if m: parts.append(f"{m}m")
        parts.append(f"{s}s")
        return " ".join(parts)
    except (OverflowError, ValueError):
        return "невідомо"

def build_today_message(outages_info: dict) -> str:
    date_value = outages_info.get("date")
    date_str = date_value.strftime("%d.%m.%Y") if hasattr(date_value, "strftime") else str(date_value)
    status = outages_info.get("status", "")
    outages = outages_info.get("outages", [])

    if status != "ScheduleApplies":
        if status == "EmergencyShutdowns":
            return (
                f"📅 Розклад на {date_str}\n"
                f"🚨 Графік не діє. Діють екстрені відключення."
            )
        if status == "WaitingForSchedule":
            return (
                f"📅 Розклад на {date_str}\n"
                f"⌛ Очікуємо оновлення"
            )
        return (
            f"📅 Розклад на {date_str}\n"
            f"⚠️ Статус: {status}"
        )

    if not outages:
        return (
            f"📅 Розклад на {date_str}\n"
            f"✅ Відключень не передбачено"
        )

    lines = [f"📅 Розклад на {date_str}", ""]
    for idx, outage in enumerate(outages, 1):
        start_str = outage["start"].strftime("%H:%M")
        end_str = outage["end"].strftime("%H:%M")
        type_label = "Планове" if outage["type"] == "Definite" else outage["type"]
        lines.append(f"{idx}. {start_str} – {end_str} ({type_label})")

    return "\n".join(lines)

def build_today_signature(outages_info: dict) -> tuple:
    date_value = outages_info.get("date")
    date_iso = date_value.isoformat() if hasattr(date_value, "isoformat") else str(date_value)
    status = outages_info.get("status")
    raw_slots = outages_info.get("raw_slots") or []
    slots_signature = tuple((slot.start_min, slot.end_min, slot.type) for slot in raw_slots)
    return date_iso, status, slots_signature


@dataclass(frozen=True)
class ReminderEvent:
    kind: Literal["outage", "restore"]
    lead_minutes: int
    trigger_at: datetime
    start: datetime
    end: datetime

    @property
    def duration_minutes(self) -> int:
        seconds = max(0, (self.end - self.start).total_seconds())
        return max(1, int(round(seconds / 60)))


def _load_schedule_bundle() -> tuple[dict, dict]:
    data = yasno.fetch()
    today = yasno.get_today_outages(data)
    tomorrow = yasno.get_tomorrow_outages(data)
    return today, tomorrow


def _extract_plan_segments(*day_infos: dict) -> list[tuple[datetime, datetime]]:
    segments: list[tuple[datetime, datetime]] = []
    for info in day_infos:
        if not info or info.get("status") != "ScheduleApplies":
            continue
        date_value = info.get("date")
        if not date_value:
            continue
        raw_slots = info.get("raw_slots") or []
        for slot in raw_slots:
            if not getattr(slot, "is_outage", False):
                continue
            start_dt, end_dt = slot.as_time_range(date_value, TZ)
            if end_dt <= start_dt:
                continue
            segments.append((start_dt, end_dt))
    return segments


def _build_reminder_events(segments: list[tuple[datetime, datetime]], now: datetime) -> list[ReminderEvent]:
    events: list[ReminderEvent] = []
    tolerance = timedelta(seconds=REMINDER_TRIGGER_WINDOW_SEC)
    for start_dt, end_dt in segments:
        if end_dt <= now:
            continue
        for lead in REMINDER_LEADS:
            trigger_outage = start_dt - timedelta(minutes=lead)
            if trigger_outage + tolerance >= now:
                events.append(
                    ReminderEvent(
                        kind="outage",
                        lead_minutes=lead,
                        trigger_at=trigger_outage,
                        start=start_dt,
                        end=end_dt,
                    )
                )
            trigger_restore = end_dt - timedelta(minutes=lead)
            if trigger_restore + tolerance >= now:
                events.append(
                    ReminderEvent(
                        kind="restore",
                        lead_minutes=lead,
                        trigger_at=trigger_restore,
                        start=start_dt,
                        end=end_dt,
                    )
                )
    return events


def _format_lead_label(minutes: int) -> str:
    if minutes >= 60 and minutes % 60 == 0:
        hours = minutes // 60
        return f"{hours} год" if hours > 1 else "1 год"
    return f"{minutes} хв"


WEEKDAY_NAMES_UA = ("Понеділок", "Вівторок", "Середа", "Четвер", "Пʼятниця", "Субота", "Неділя")


def _build_timeline_payload(outages_info: dict, scope: Literal["today", "tomorrow"]) -> dict | None:
    status = outages_info.get("status")
    if status != "ScheduleApplies":
        return None

    date_value = outages_info.get("date")
    if isinstance(date_value, datetime):
        day_date = date_value.date()
    else:
        day_date = date_value or datetime.now(TZ).date()

    raw_slots = outages_info.get("raw_slots") or []
    plan_segments = _normalise_plan_segments(raw_slots)
    now = datetime.now(TZ)
    show_current_time = scope == "today"
    has_plan_segments = bool(plan_segments)
    summary = _build_timeline_summary(plan_segments)

    day_label = _format_timeline_day_label(day_date)
    context_label = "Сьогодні" if scope == "today" else "Завтра"
    if scope == "tomorrow":
        day_label = f"Завтра · {day_label}"

    return {
        "slots": _build_snake_slots(plan_segments),
        "dayLabel": day_label,
        "dateLabel": day_date.strftime("%d.%m.%Y"),
        "nowHour": _hour_fraction(now) if show_current_time else -1,
        "status": status,
        "hasPlanSegments": has_plan_segments,
        "isPlaceholder": not has_plan_segments,
        "currentTimeLabel": now.strftime("%H:%M") if show_current_time else "—:—",
        "summary": summary,
        "contextLabel": context_label,
        "showCurrentTimeIndicator": show_current_time,
    }


def _normalise_plan_segments(raw_slots) -> list[tuple[float, float]]:
    segments: list[tuple[float, float]] = []
    for slot in raw_slots:
        if not getattr(slot, "is_outage", False):
            continue
        start_min = getattr(slot, "start_min", None)
        end_min = getattr(slot, "end_min", None)
        if start_min is None or end_min is None:
            continue
        start_hour = _clamp(float(start_min) / 60.0, 0.0, 24.0)
        end_hour = _clamp(float(end_min) / 60.0, 0.0, 24.0)
        if end_hour <= start_hour:
            continue
        segments.append((start_hour, end_hour))
    return _merge_segments(segments)


def _build_snake_slots(plan_segments: list[tuple[float, float]]) -> list[dict[str, float]]:
    slots: list[dict[str, float]] = []
    for index in range(24):
        start_hour = float(index)
        end_hour = start_hour + 1.0
        overlaps: list[tuple[float, float]] = []
        for segment_start, segment_end in plan_segments:
            overlap_start = max(segment_start, start_hour)
            overlap_end = min(segment_end, end_hour)
            if overlap_end <= overlap_start:
                continue
            overlaps.append((overlap_start, overlap_end))

        if overlaps:
            coverage_start = min(start for start, _ in overlaps)
            coverage_end = max(end for _, end in overlaps)
            fill_start_ratio = _clamp(coverage_start - start_hour, 0.0, 1.0)
            fill_end_ratio = _clamp(coverage_end - start_hour, 0.0, 1.0)
            fill_ratio = _clamp(fill_end_ratio - fill_start_ratio, 0.0, 1.0)
        else:
            fill_start_ratio = 0.0
            fill_ratio = 0.0

        slots.append(
            {
                "index": index,
                "startHour": start_hour,
                "endHour": end_hour,
                "fillRatio": fill_ratio,
                "fillStartRatio": fill_start_ratio,
            }
        )

    return slots


def _build_timeline_summary(plan_segments: list[tuple[float, float]]) -> dict:
    total_hours = 0.0
    for start_hour, end_hour in plan_segments:
        total_hours += max(0.0, end_hour - start_hour)
    total_hours = _clamp(total_hours, 0.0, 24.0)
    light_hours = _clamp(24.0 - total_hours, 0.0, 24.0)
    return {
        "plannedHours": total_hours,
        "actualHours": total_hours,
        "outageHours": total_hours,
        "lightHours": light_hours,
        "diffHours": 0.0,
        "hasActualData": bool(plan_segments),
    }


def _merge_segments(segments: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not segments:
        return []
    sorted_segments = sorted(segments, key=lambda item: item[0])
    merged: list[list[float]] = [[sorted_segments[0][0], sorted_segments[0][1]]]
    for start_hour, end_hour in sorted_segments[1:]:
        last_start, last_end = merged[-1]
        if start_hour <= last_end:
            merged[-1][1] = max(last_end, end_hour)
        else:
            merged.append([start_hour, end_hour])
    return [(start, end) for start, end in merged]


def _format_timeline_day_label(day_date):
    weekday = WEEKDAY_NAMES_UA[day_date.weekday()] if day_date else "Невідомий день"
    return f"{weekday} ({day_date.strftime('%d.%m')})"


def _hour_fraction(date_obj: datetime) -> float:
    return date_obj.hour + date_obj.minute / 60 + date_obj.second / 3600


def _clamp(value: float, lower: float, upper: float) -> float:
    if value < lower:
        return lower
    if value > upper:
        return upper
    return value


async def create_schedule_screenshot(outages_info: dict, scope: Literal["today", "tomorrow"]) -> Path | None:
    if not TIMELINE_SCREENSHOT_ENABLED:
        return None

    script_path = TIMELINE_SCREENSHOT_SCRIPT
    if not script_path or not script_path.exists():
        logging.debug("Скрипт скріншотів не знайдено: %s", script_path)
        return None

    python_exec = Path(TIMELINE_SCREENSHOT_PYTHON)
    print("python_exec: " + str(python_exec))
    if not python_exec.exists():
        logging.error("Інтерпретатор для скріншоту не знайдено: %s", python_exec)
        return None

    payload = _build_timeline_payload(outages_info, scope)
    if not payload:
        logging.debug("Немає даних для скріншоту (scope=%s).", scope)
        return None

    output_dir = Path(tempfile.gettempdir())
    output_path = output_dir / f"timeline-{scope}-{int(time.time())}.png"
    cmd = [
        str(python_exec),
        str(script_path),
        "--json",
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        "--output",
        str(output_path),
    ]
    if TIMELINE_SCREENSHOT_BASE_URL:
        cmd.extend(["--base-url", TIMELINE_SCREENSHOT_BASE_URL])

    try:
        process = await asyncio.create_subprocess_exec(*cmd, stdout=PIPE, stderr=PIPE)
    except FileNotFoundError:
        logging.exception("Не вдалося запустити скрипт скріншотів.")
        return None

    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        logging.error(
            "Скрипт скріншотів завершився з помилкою (scope=%s, code=%s): %s",
            scope,
            process.returncode,
            stderr.decode(errors="ignore").strip(),
        )
        return None

    stdout_text = stdout.decode(errors="ignore").strip()
    if stdout_text:
        logging.info("Скрипт скріншотів: %s", stdout_text)

    if not output_path.exists():
        logging.error("Очікуваний файл скріншоту не знайдено: %s", output_path)
        return None

    return output_path


def _cleanup_temp_file(path: Path | None):
    if not path:
        return
    with contextlib.suppress(Exception):
        path.unlink()


async def notify(bot: Bot, text: str, photo_path: str | None = None):
    if not ALERT_CHAT_TARGETS:
        return
    photo_candidate: Path | None = None
    if photo_path:
        candidate = Path(photo_path)
        if candidate.exists():
            photo_candidate = candidate
        else:
            logging.warning("Файл для вкладення не знайдено: %s", photo_path)

    for chat_id, thread_id in ALERT_CHAT_TARGETS:
        try:
            if photo_candidate:
                file_input = types.FSInputFile(str(photo_candidate))
                if thread_id is None:
                    await bot.send_photo(chat_id, file_input, caption=text)
                else:
                    await bot.send_photo(chat_id, file_input, caption=text, message_thread_id=thread_id)
            else:
                if thread_id is None:
                    await bot.send_message(chat_id, text)
                else:
                    await bot.send_message(chat_id, text, message_thread_id=thread_id)
            await asyncio.sleep(0.05)  # невеликий тротлінг між повідомленнями
        except Exception as e:
            logging.error("send_message failed (%s): %s", chat_id, e)

async def web_notify(payload: dict):
    """
    Надсилає серверу веб-додатка подію, яка:
      - очищає відповідний кеш
      - розсилає SSE у відкриті вкладки
      - надсилає PWA push-нотифікацію
    """
    if not WEB_NOTIFY_URL or not NOTIFY_BOT_TOKEN:
        return
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        WEB_NOTIFY_URL,
        data=body,
        headers={"Content-Type": "application/json", "x-bot-token": NOTIFY_BOT_TOKEN},
        method="POST",
    )
    def _do():
        try:
            with urllib.request.urlopen(req, timeout=2.5) as _:
                return
        except urllib.error.URLError:
            return
    await asyncio.to_thread(_do)

# ───────────────── Telegram handlers ─────────────────
@router.message(Command("start"))
async def cmd_start(m: Message):
    if await _skip_if_blocked(m):
        return
    await m.answer(
        "👋 Бот моніторингу живлення ЖК 4U з графіками відключень YASNO.\n"
        f"Група: {YASNO_GROUP}\n"
    )

@router.message(Command("notifyweb"))
async def cmd_notifyweb(m: Message, command: CommandObject):
    """
    Адмін-команда для ручної відправки сповіщення у веб-застосунок.
    Використання:
      /notifyweb type=power_outage_started title="Світло зникло" body="Тест"
    Або:
      /notifyweb {"type":"custom","title":"Тест","body":"Повідомлення"}
    """
    if await _skip_if_blocked(m):
        return
    # Дозволяємо лише з адмін-чату
    if m.chat.id != ADMIN_LOG_CHAT_ID:
        return
    if not WEB_NOTIFY_URL or not NOTIFY_BOT_TOKEN:
        await m.answer("⚠️ WEB-сповіщення не налаштовано (перевір WEB_NOTIFY_URL/NOTIFY_BOT_TOKEN).")
        return

    args = command.args or ""
    payload: dict[str, str] = {}
    args_stripped = args.strip()
    if args_stripped.startswith("{") and args_stripped.endswith("}"):
        try:
            obj = json.loads(args_stripped)
            if isinstance(obj, dict):
                for k in ("type", "title", "body"):
                    if k in obj and isinstance(obj[k], str):
                        payload[k] = obj[k]
        except Exception:
            await m.answer("❌ Невірний JSON у параметрах.")
            return
    else:
        # Парсимо key=value з підтримкою лапок
        try:
            for match in re.finditer(r'(type|title|body)=(?:"([^"]*)"|\'([^\']*)\'|(\S+))', args):
                key = match.group(1)
                val = match.group(2) or match.group(3) or match.group(4) or ""
                payload[key] = val
        except Exception:
            await m.answer("❌ Невірний формат параметрів. Спробуйте title=\"...\" тощо.")
            return

    ptype = str(payload.get("type") or "custom")
    title = str(payload.get("title") or "Адмін-сповіщення")
    body = str(payload.get("body") or "")

    await web_notify({"type": ptype, "title": title, "body": body})
    await m.answer(f"✅ Відправлено у WEB: type={ptype}\nЗаголовок: {title}\nТіло: {body[:200]}")

@router.message(Command("subcount"))
async def cmd_subcount(m: Message):
    if await _skip_if_blocked(m):
        return
    # Доступ лише з адмін-чату
    if m.chat.id != ADMIN_LOG_CHAT_ID:
        return
    try:
        count = await db.get_push_subscriptions_count()
        await m.answer(f"🔢 Кількість підписок: {count}")
    except Exception as e:
        logging.error("cmd_subcount error: %s", e)
        await m.answer("❌ Не вдалося отримати кількість підписок")

@router.message(Command("status"))
async def cmd_status(m: Message):
    if await _skip_if_blocked(m):
        return
    print("status chat_id: " + str(m.chat.id))
    thread_id = m.message_thread_id
    username = None
    if m.from_user:
        if getattr(m.from_user, "username", None):
            username = "@" + str(m.from_user.username)
        else:
            first = getattr(m.from_user, "first_name", "") or ""
            last = getattr(m.from_user, "last_name", "") or ""
            username = (first + " " + last).strip() or None
    if ADMIN_LOG_CHAT_ID:
        log_text = f"📮 status від chat={m.chat.id}"
        if username:
            log_text += f", login={username}"
        if thread_id is not None:
            log_text += f", thread={thread_id}"
        try:
            await m.bot.send_message(ADMIN_LOG_CHAT_ID, log_text, disable_notification=True)
        except Exception as e:
            logging.error("Failed to send status log: %s", e)
    now = datetime.now(TZ)
    def _fetch_schedule_messages(moment: datetime):
        data = yasno.fetch()
        outage_msg = yasno.get_nearest_outage_message(now=moment, data_override=data)
        restore_msg = yasno.get_nearest_restore_message(now=moment, data_override=data)
        return outage_msg, restore_msg

    try:
        outage_text, restore_text = await asyncio.to_thread(_fetch_schedule_messages, now)
    except Exception as e:
        logging.error("cmd_status schedule fetch error: %s", e)
        outage_text = "⚠️ Не вдалося отримати графік"
        restore_text = "⚠️ Не вдалося отримати графік"

    secs = listener.seconds_since_last_packet()
    power_down = secs > threshold_sec
    state = "❌ світла немає" if power_down else "✅ світло є"
    schedule_text = restore_text if power_down else outage_text

    await m.answer(f"{state}\n{schedule_text}")

@router.message(Command("today"))
async def cmd_today(m: Message):
    if await _skip_if_blocked(m):
        return
    try:
        outages_info = await asyncio.to_thread(yasno.get_today_outages)
        message = build_today_message(outages_info)
        await m.answer(message)
    except Exception as e:
        logging.error("cmd_today error: %s", e)
        await m.answer("❌ Помилка при завантаженні графіку")

@router.message(Command("tomorrow"))
async def cmd_tomorrow(m: Message):
    if await _skip_if_blocked(m):
        return
    try:
        outages_info = await asyncio.to_thread(yasno.get_tomorrow_outages)
        date_str = outages_info["date"].strftime("%d.%m.%Y")
        status = outages_info["status"]
        outages = outages_info["outages"]
        
        if status != "ScheduleApplies":
            if status == "EmergencyShutdowns":
                await m.answer(
                    f"📅 Розклад на {date_str}\n"
                    f"🚨 Графік не діє. Діють екстрені відключення."
                )
            elif status == "WaitingForSchedule":
                await m.answer(
                    f"📅 Розклад на {date_str}\n"
                    f"⌛ Очікуємо оновлення"
                )
            else:
                await m.answer(
                    f"📅 Розклад на {date_str}\n"
                    f"⚠️ Статус: {status}"
                )
            return
        
        if not outages:
            await m.answer(
                f"📅 Розклад на {date_str}\n"
                f"✅ Відключень не передбачено"
            )
            return
        
        message = f"📅 Розклад на {date_str}\n\n"
        for idx, outage in enumerate(outages, 1):
            start_str = outage["start"].strftime("%H:%M")
            end_str = outage["end"].strftime("%H:%M")
            type_label = "Планове" if outage["type"] == "Definite" else outage["type"]
            message += f"{idx}. {start_str} – {end_str} ({type_label})\n"
        
        await m.answer(message)
    except Exception as e:
        logging.error("cmd_tomorrow error: %s", e)
        await m.answer("❌ Помилка при завантаженні графіку")


@router.message(Command("testscreenshot"))
async def cmd_testscreenshot(m: Message, command: CommandObject):
    if await _skip_if_blocked(m):
        return
    if m.chat.id != ADMIN_LOG_CHAT_ID:
        return

    args = (command.args or "").strip().lower()
    scope: Literal["today", "tomorrow"] = "today"
    if args in {"tomorrow", "t", "завтра"}:
        scope = "tomorrow"

    scope_label = "сьогодні" if scope == "today" else "завтра"
    await m.answer(f"🧪 Готуємо скріншот графіка на {scope_label}…")

    try:
        outages_info = await asyncio.to_thread(
            yasno.get_today_outages if scope == "today" else yasno.get_tomorrow_outages
        )
    except Exception as error:
        logging.error("testscreenshot fetch error (%s): %s", scope, error)
        await m.answer(f"❌ Не вдалося отримати графік на {scope_label}.")
        return

    message_body = build_today_message(outages_info)
    screenshot_path: Path | None = None
    try:
        screenshot_path = await create_schedule_screenshot(outages_info, scope=scope)
    except Exception:
        logging.exception("testscreenshot generation error (%s)", scope)

    try:
        if screenshot_path:
            photo = types.FSInputFile(str(screenshot_path))
            await m.answer_photo(
                photo,
                caption=f"🧪 Тестовий скріншот ({scope_label}):\n\n{message_body}",
            )
        else:
            await m.answer(f"⚠️ Скріншот не згенеровано. Повідомлення:\n\n{message_body}")
    finally:
        _cleanup_temp_file(screenshot_path)

# ───────────────── background monitor ─────────────────
async def schedule_monitor(bot: Bot):
    global last_today_signature, last_today_date

    while True:
        try:
            outages_info = await asyncio.to_thread(yasno.get_today_outages)
            today_date = outages_info.get("date")
            status = outages_info.get("status")
            raw_slots = outages_info.get("raw_slots") or []
            slots_signature = tuple((slot.start_min, slot.end_min, slot.type) for slot in raw_slots)
            # НЕ порівнюємо дату, оскільки вона змінюється о 00:00
            current_signature = (status, slots_signature)
            persist_required = False
            message_body = None

            # Якщо змінилася календарна дата — просто скидаємо базову точку без сповіщення
            if last_today_date is None:
                last_today_date = today_date
                last_today_signature = current_signature
                persist_required = True
            elif today_date != last_today_date:
                last_today_date = today_date
                last_today_signature = current_signature
                persist_required = True
            elif current_signature != last_today_signature:
                last_today_signature = current_signature
                persist_required = True
                message_body = build_today_message(outages_info)

            if persist_required:
                await db.upsert_schedule(today_date, status, outages_info.get("outages"), raw_slots)
            if message_body:
                screenshot_path: Path | None = None
                try:
                    screenshot_path = await create_schedule_screenshot(outages_info, scope="today")
                except Exception:
                    logging.exception("Помилка при генерації скріншоту (today).")
                try:
                    await notify(
                        bot,
                        f"🔔 Графік на сьогодні оновлено!\n\n{message_body}",
                        photo_path=str(screenshot_path) if screenshot_path else None,
                    )
                finally:
                    _cleanup_temp_file(screenshot_path)

                asyncio.create_task(web_notify({
                    "type": "schedule_updated",
                    "category": "schedule_change",
                    "title": "🔔 Графік на сьогодні оновлено!",
                    "body": message_body,
                }))

            await asyncio.sleep(SCHEDULE_POLL_INTERVAL_SEC)
        except asyncio.CancelledError:
            break
        except Exception:
            logging.exception("Schedule monitor error")
            await asyncio.sleep(SCHEDULE_POLL_INTERVAL_SEC)

async def schedule_monitor_tomorrow(bot: Bot):
    global last_tomorrow_status, last_tomorrow_date

    while True:
        try:
            outages_info = await asyncio.to_thread(yasno.get_tomorrow_outages)
            tomorrow_date = outages_info.get("date")
            current_status = outages_info.get("status", "")
            raw_slots = outages_info.get("raw_slots") or []
            slots_signature = tuple((slot.start_min, slot.end_min, slot.type) for slot in raw_slots)
            persist_required = False
            message_body = None

            # Якщо змінилася дата "завтра" (перехід доби) — скидаємо стан без сповіщення
            if last_tomorrow_date is None:
                last_tomorrow_date = tomorrow_date
                last_tomorrow_status = (current_status, slots_signature)
                persist_required = True
            elif tomorrow_date != last_tomorrow_date:
                last_tomorrow_date = tomorrow_date
                last_tomorrow_status = (current_status, slots_signature)
                persist_required = True
            else:
                # Порівнюємо статус і вміст слотів, ігноруючи дату
                old_status, old_slots = last_tomorrow_status
                if old_status == "WaitingForSchedule" and current_status == "ScheduleApplies":
                    # Розклад став доступний
                    last_tomorrow_status = (current_status, slots_signature)
                    persist_required = True
                    message_body = build_today_message(outages_info)
                elif current_status != old_status or slots_signature != old_slots:
                    # Щось інше змінилось (але не при переходу дня без змін)
                    last_tomorrow_status = (current_status, slots_signature)
                    persist_required = True

            if persist_required:
                await db.upsert_schedule(tomorrow_date, current_status, outages_info.get("outages"), raw_slots)
            if message_body:
                screenshot_path: Path | None = None
                try:
                    screenshot_path = await create_schedule_screenshot(outages_info, scope="tomorrow")
                except Exception:
                    logging.exception("Помилка при генерації скріншоту (tomorrow).")
                try:
                    await notify(
                        bot,
                        f"🔔 З'явився графік на завтра!\n\n{message_body}",
                        photo_path=str(screenshot_path) if screenshot_path else None,
                    )
                finally:
                    _cleanup_temp_file(screenshot_path)

                asyncio.create_task(web_notify({
                    "type": "schedule_updated",
                    "category": "schedule_change",
                    "title": "🔔 З'явився графік на завтра!",
                    "body": message_body,
                }))

            await asyncio.sleep(SCHEDULE_POLL_INTERVAL_SEC + 1)
        except asyncio.CancelledError:
            break
        except Exception:
            logging.exception("Schedule monitor tomorrow error")
            await asyncio.sleep(SCHEDULE_POLL_INTERVAL_SEC)


async def reminder_scheduler(bot: Bot):
    while True:
        try:
            now = datetime.now(TZ)
            now_ts = now.timestamp()
            power_down = listener.seconds_since_last_packet() > threshold_sec

            try:
                today_info, tomorrow_info = await asyncio.to_thread(_load_schedule_bundle)
            except Exception as fetch_error:
                logging.error("Reminder scheduler fetch error: %s", fetch_error)
                await asyncio.sleep(20.0)
                continue

            segments = _extract_plan_segments(today_info, tomorrow_info)
            if not segments:
                _prune_reminder_history(now_ts)
                await asyncio.sleep(30.0)
                continue

            events = _build_reminder_events(segments, now)
            for event in events:
                key = f"{event.kind}:{event.start.isoformat()}:{event.lead_minutes}"
                if key in reminder_history:
                    continue
                delta = (now - event.trigger_at).total_seconds()
                if delta < 0 or delta > REMINDER_TRIGGER_WINDOW_SEC:
                    continue
                if (event.kind == "outage" and power_down) or (event.kind == "restore" and not power_down):
                    reminder_history[key] = now_ts
                    continue

                await send_plan_reminder(event, power_down)
                reminder_history[key] = now_ts

            _prune_reminder_history(now_ts)
            await asyncio.sleep(20.0)
        except asyncio.CancelledError:
            break
        except Exception:
            logging.exception("Reminder scheduler error")
            await asyncio.sleep(20.0)


async def send_plan_reminder(event: ReminderEvent, power_down: bool):
    lead_label = _format_lead_label(event.lead_minutes)
    if event.kind == "outage":
        title = f"⏳ Відключення за {lead_label}"
        fallback_body = f"Світло є, але за {lead_label} почнеться планове відключення."
    else:
        title = f"⏳ Відновлення за {lead_label}"
        fallback_body = f"Світла немає, але за {lead_label} має відновитися згідно графіка."

    await web_notify({
        "type": "reminder",
        "category": "reminder",
        "title": title,
        "body": fallback_body,
        "reminderLeadMinutes": event.lead_minutes,
        "data": {
            "networkState": "off" if power_down else "on",
            "tag": "power-status",
            "reminder": {
                "kind": event.kind,
                "leadMinutes": event.lead_minutes,
                "startISO": event.start.isoformat(),
                "endISO": event.end.isoformat(),
                "durationMinutes": event.duration_minutes,
            },
        },
    })


def _prune_reminder_history(now_ts: float):
    stale_keys = [
        key for key, ts in reminder_history.items() if (now_ts - ts) > REMINDER_HISTORY_TTL_SEC
    ]
    for key in stale_keys:
        reminder_history.pop(key, None)


async def power_monitor(bot: Bot):
    """
    Періодично перевіряє відсутність/наявність UDP-пакетів і шле сповіщення.
    """
    await asyncio.sleep(1.0)  # трохи часу, щоб встигли зробити /start

    while True:
        try:
            secs = listener.seconds_since_last_packet()
            now = time.time()

            outage_detected = False
            outage_start_candidate = None

            if secs == float("inf"):
                if (now - startup_ts) > threshold_sec:
                    outage_detected = True
                    outage_start_candidate = startup_ts
            elif secs > threshold_sec:
                outage_detected = True
                outage_start_candidate = now - secs

            active_outage = await db.get_active_outage()

            if outage_detected:
                if active_outage is None:
                    start_ts = outage_start_candidate if outage_start_candidate is not None else now
                    await db.log_outage_start(start_ts)
                    try:
                        now_dt = datetime.fromtimestamp(now, tz=TZ)
                        restore_msg = await asyncio.to_thread(yasno.get_nearest_restore_message, now_dt)
                        await notify(
                            bot,
                            f"🔔⚠️ Світло ЗНИКЛО.\n{restore_msg}"
                        )
                        asyncio.create_task(web_notify({
                            "type": "power_outage_started",
                            "category": "actual",
                            "title": "⚠️ Світло зникло",
                            "body": restore_msg,
                            "data": {
                                "networkState": "off",
                                "tag": "power-status",
                                "planMessage": restore_msg,
                            },
                        }))
                    except Exception as e:
                        logging.error("Failed to get restore message: %s", e)
                        await notify(bot, "⚠️ Світло ЗНИКЛО.")
                        asyncio.create_task(web_notify({
                            "type": "power_outage_started",
                            "category": "actual",
                            "title": "Світло зникло",
                            "body": "",
                            "data": {
                                "networkState": "off",
                                "tag": "power-status",
                            },
                        }))
            else:
                if active_outage is not None and secs != float("inf"):
                    start_ts = await db.log_outage_end(now)
                    effective_start = start_ts if start_ts is not None else now
                    downtime = max(0.0, now - effective_start)
                    nearest_msg = ""
                    try:
                        now_dt = datetime.fromtimestamp(now, tz=TZ)
                        nearest_msg = await asyncio.to_thread(yasno.get_nearest_outage_message, now_dt)
                    except Exception as e:
                        logging.error("Failed to get nearest outage message: %s", e)
                    body_lines = [
                        "🔔✅ Світло ВІДНОВЛЕНО.",
                        f"Час без світла: {fmt_duration(downtime)}",
                    ]
                    if nearest_msg:
                        body_lines.append(nearest_msg)
                    message_text = "\n".join(body_lines)
                    await notify(bot, message_text)
                    asyncio.create_task(web_notify({
                        "type": "power_restored",
                        "category": "actual",
                        "title": "✅ Світло ВІДНОВЛЕНО.",
                        "body": "\n".join(body_lines[1:]) if nearest_msg else body_lines[1],
                        "data": {
                            "networkState": "on",
                            "tag": "power-status",
                            "downtimeSeconds": downtime,
                            "planMessage": nearest_msg,
                        },
                    }))
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            break
        except Exception:
            logging.exception("Monitor error")
            await asyncio.sleep(1.0)

# ───────────────── lifecycle hooks (aiogram v3) ─────────────────
# У v3 хендлери startup/shutdown реєструються через dp.startup.register / dp.shutdown.register,
# а аргументи (dispatcher, bot тощо) підставляються DI-системою.
# Див. офіційну документацію Dispatcher/Long-polling/DI. :contentReference[oaicite:1]{index=1}
async def on_startup(dispatcher: Dispatcher, bot: Bot):
    global startup_ts
    startup_ts = time.time()
    # стартуємо UDP-лісенер
    listener.start()

    # простий лог кожного пакета (можна прибрати)
    def _on_packet(msg, addr):
        print(f"[UDP] From {addr}: {msg}")
    listener.on_packet = _on_packet

    # запускаємо фоновий монітор і кладемо task у workflow_data диспетчера
    monitor_task = asyncio.create_task(power_monitor(bot))
    dispatcher.workflow_data["monitor_task"] = monitor_task

    schedule_task = asyncio.create_task(schedule_monitor(bot))
    dispatcher.workflow_data["schedule_task"] = schedule_task

    schedule_tomorrow_task = asyncio.create_task(schedule_monitor_tomorrow(bot))
    dispatcher.workflow_data["schedule_tomorrow_task"] = schedule_tomorrow_task
    reminder_task = asyncio.create_task(reminder_scheduler(bot))
    dispatcher.workflow_data["reminder_task"] = reminder_task
    print("[startup] UDP listener started, monitor and schedule tasks running")

async def on_shutdown(dispatcher: Dispatcher, bot: Bot):
    # акуратно гасимо фоновий таск монітора
    for key in ("monitor_task", "schedule_task", "schedule_tomorrow_task", "reminder_task"):
        task = dispatcher.workflow_data.get(key)
        if task:
            task.cancel()
            with contextlib.suppress(Exception):
                await task
    listener.stop()
    db.close()
    print("[shutdown] Clean exit")

# ───────────────── main ─────────────────
async def main():
    logging.basicConfig(level=logging.INFO)
    if not BOT_TOKEN:
        raise SystemExit("⚠️ Не знайдено BOT_TOKEN. Додай у .env або в код.")

    bot = Bot(BOT_TOKEN)
    dp = Dispatcher()
    dp.include_router(router)

    # Реєструємо lifecycle-хендлери (v3-стиль)
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)

    # Контекстне керування клієнтом бота
    async with bot:
        await dp.start_polling(bot, allowed_updates=None)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        print("Stopped")
