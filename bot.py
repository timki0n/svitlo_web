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
from typing import Any, Final, Literal

from aiogram import Bot, Dispatcher, Router, types
from aiogram.client.default import DefaultBotProperties
from aiogram.types import Message
from aiogram.filters import Command, CommandObject

from dotenv import load_dotenv
from udp_listener import UDPListener
from yasno_outages import (
    STATUS_EMERGENCY_SHUTDOWNS,
    STATUS_NO_OUTAGES,
    STATUS_SCHEDULE_APPLIES,
    STATUS_WAITING_FOR_SCHEDULE,
    YasnoOutages,
    is_published_schedule,
)
from storage import db



# ───────────────── env / config ─────────────────
load_dotenv()  # підтягуємо .env із поточної директорії

YASNO_GROUP = os.getenv("YASNO_GROUP", "12.1")

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
SILENT_CHAT_TARGETS: Final[tuple[tuple[int, int | None], ...]] = _parse_chat_targets_env(os.getenv("SILENT_CHAT_ID"))
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
SCHEDULE_URL: Final[str] = "https://svitlo4u.online"


def schedule_link(label: str) -> str:
    return f'<a href="{SCHEDULE_URL}">{label}</a>'


_SCHEDULE_ANCHOR_RE = re.compile(rf'<a href="{re.escape(SCHEDULE_URL)}">(.*?)</a>')


def _strip_schedule_anchors(text: str) -> str:
    """Прибирає HTML-лінки schedule_link, лишаючи лише підпис."""
    return _SCHEDULE_ANCHOR_RE.sub(r"\1", text)


def _sanitize_web_payload(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {key: _sanitize_web_payload(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_web_payload(value) for value in obj]
    if isinstance(obj, str):
        return _strip_schedule_anchors(obj)
    return obj

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


def _is_chat_silent(chat_id: int, thread_id: int | None) -> bool:
    """Перевіряє, чи всі повідомлення (крім адмінів) мають видалятися у цьому чаті."""
    if not SILENT_CHAT_TARGETS:
        return False
    for silent_chat_id, silent_thread_id in SILENT_CHAT_TARGETS:
        if silent_chat_id != chat_id:
            continue
        if silent_thread_id is None:
            if thread_id is None:
                return True
            continue
        if silent_thread_id == thread_id:
            return True
    return False


async def _is_user_admin(bot: Bot, chat_id: int, user_id: int) -> bool:
    """Перевіряє, чи є користувач адміністратором чату."""
    try:
        member = await bot.get_chat_member(chat_id, user_id)
        return member.status in ("creator", "administrator")
    except Exception:
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

def fmt_duration_long(seconds: float) -> str:
    """Форматує тривалість з днями, годинами, хвилинами."""
    try:
        seconds = int(seconds)
        days = seconds // 86400
        hours = (seconds % 86400) // 3600
        minutes = (seconds % 3600) // 60
        parts = []
        if days == 1:
            parts.append("1 день")
        elif days >= 2 and days <= 4:
            parts.append(f"{days} дні")
        elif days >= 5:
            parts.append(f"{days} днів")
        if hours == 1:
            parts.append("1 год.")
        elif hours >= 2:
            parts.append(f"{hours} год.")
        if minutes == 1:
            parts.append("1 хв.")
        elif minutes >= 2:
            parts.append(f"{minutes} хв.")
        if not parts:
            return "менше хвилини"
        return " ".join(parts)
    except (OverflowError, ValueError):
        return "невідомо"

def format_duration(start: datetime, end: datetime) -> str:
    """Format outage duration as 'X год.' or 'X год. Y хв.'"""
    delta = end - start
    total_minutes = int(delta.total_seconds() / 60)
    hours = total_minutes // 60
    minutes = total_minutes % 60
    if minutes == 0:
        return f"{hours} год."
    return f"{hours} год. {minutes} хв."

def build_today_message(outages_info: dict) -> str:
    date_value = outages_info.get("date")
    date_str = date_value.strftime("%d.%m.%Y") if hasattr(date_value, "strftime") else str(date_value)
    status = outages_info.get("status", "")
    outages = outages_info.get("outages", [])

    if status == STATUS_EMERGENCY_SHUTDOWNS:
        return (
            f"📅 Розклад на {date_str}\n"
            f"🚨 {schedule_link('Графік')} не діє. Діють екстрені відключення."
        )
    if status == STATUS_WAITING_FOR_SCHEDULE:
        return (
            f"📅 Розклад на {date_str}\n"
            f"⌛ Очікуємо оновлення"
        )
    # NoOutages — опублікований графік без відключень, як ScheduleApplies з порожнім списком.
    if status == STATUS_NO_OUTAGES or (status == STATUS_SCHEDULE_APPLIES and not outages):
        return (
            f"📅 Розклад на {date_str}\n"
            f"✅ Відключень не передбачено"
        )
    if status != STATUS_SCHEDULE_APPLIES:
        return (
            f"📅 Розклад на {date_str}\n"
            f"⚠️ {schedule_link('Графік')} недоступний."
        )

    lines = [f"📅 Розклад на {date_str}", ""]
    for idx, outage in enumerate(outages, 1):
        start_str = outage["start"].strftime("%H:%M")
        end_str = outage["end"].strftime("%H:%M")
        duration_label = format_duration(outage["start"], outage["end"])
        lines.append(f"{idx}. {start_str} – {end_str} ({duration_label})")

    return "\n".join(lines)

_UK_MONTHS_SHORT = (
    "січ.", "лют.", "бер.", "квіт.", "трав.", "черв.",
    "лип.", "серп.", "вер.", "жовт.", "лист.", "груд.",
)


def format_last_schedule_update(updated_on: str | None) -> str | None:
    """Час updatedOn з Yasno у київській зоні: 12:55 06 жовт. 2026."""
    if not updated_on:
        return None
    try:
        moment = datetime.fromisoformat(updated_on)
    except ValueError:
        return None
    local = moment.astimezone(TZ)
    month = _UK_MONTHS_SHORT[local.month - 1]
    return f"Останнє оновлення: {local:%H:%M} {local:%d} {month} {local.year}"


def with_last_schedule_update(message: str, outages_info: dict) -> str:
    line = format_last_schedule_update(outages_info.get("updated_on"))
    if not line:
        return message
    return f"{message}\n\n{line}"

def _is_schedule_without_outages(status: str | None, slots_signature: tuple) -> bool:
    """NoOutages і ScheduleApplies без інтервалів — один графік, сповіщення не потрібне."""
    if status == STATUS_NO_OUTAGES:
        return True
    if status != STATUS_SCHEDULE_APPLIES:
        return False
    return not any(slot_type != "NotPlanned" for _start, _end, slot_type in slots_signature)


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
        if not info or info.get("status") not in [STATUS_SCHEDULE_APPLIES, STATUS_EMERGENCY_SHUTDOWNS]:
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


async def create_schedule_screenshot(_outages_info: dict, scope: Literal["today", "tomorrow"]) -> Path | None:
    if not TIMELINE_SCREENSHOT_ENABLED:
        return None

    script_path = TIMELINE_SCREENSHOT_SCRIPT
    if not script_path or not script_path.exists():
        logging.debug("Скрипт скріншотів не знайдено: %s", script_path)
        return None

    python_exec = Path(TIMELINE_SCREENSHOT_PYTHON)
    if not python_exec.exists():
        logging.error("Інтерпретатор для скріншоту не знайдено: %s", python_exec)
        return None

    output_dir = Path(tempfile.gettempdir())
    output_path = output_dir / f"timeline-{scope}-{int(time.time())}.png"
    cmd = [
        str(python_exec),
        str(script_path),
        "--output",
        str(output_path),
    ]
    if TIMELINE_SCREENSHOT_BASE_URL:
        cmd.extend(["--base-url", TIMELINE_SCREENSHOT_BASE_URL])
    if NOTIFY_BOT_TOKEN:
        cmd.extend(["--bot-token", NOTIFY_BOT_TOKEN])
    if scope == "tomorrow":
        cmd.extend(["--scope", "tomorrow"])


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


# Retry налаштування для відправки повідомлень (коли інтернет ще не відновився)
NOTIFY_RETRY_DELAYS: Final[tuple[float, ...]] = (5, 10, 15, 30, 60, 120, 180)  # секунди між спробами
NOTIFY_MAX_TOTAL_TIME: Final[float] = 1800.0  # максимальний час очікування (30 хв)


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
        start_time = time.time()
        attempt = 0
        while True:
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
                break  # успішно відправлено
            except Exception as e:
                elapsed = time.time() - start_time
                if elapsed >= NOTIFY_MAX_TOTAL_TIME:
                    logging.error("notify: вичерпано час очікування для chat=%s: %s", chat_id, e)
                    break
                delay = NOTIFY_RETRY_DELAYS[min(attempt, len(NOTIFY_RETRY_DELAYS) - 1)]
                logging.warning(
                    "notify: спроба %d не вдалася для chat=%s, повтор через %.0fs: %s",
                    attempt + 1, chat_id, delay, e
                )
                await asyncio.sleep(delay)
                attempt += 1


async def web_notify(payload: dict):
    """
    Надсилає серверу веб-додатка подію, яка:
      - очищає відповідний кеш
      - розсилає SSE у відкриті вкладки
      - надсилає PWA push-нотифікацію
    З retry логікою на випадок відсутності інтернету.
    """
    if not WEB_NOTIFY_URL or not NOTIFY_BOT_TOKEN:
        return
    sanitized_payload = _sanitize_web_payload(payload)
    body = json.dumps(sanitized_payload).encode("utf-8")

    start_time = time.time()
    attempt = 0
    while True:
        req = urllib.request.Request(
            WEB_NOTIFY_URL,
            data=body,
            headers={"Content-Type": "application/json", "x-bot-token": NOTIFY_BOT_TOKEN},
            method="POST",
        )
        def _do():
            try:
                with urllib.request.urlopen(req, timeout=5.0) as _:
                    return None  # успіх
            except urllib.error.URLError as e:
                return e
            except Exception as e:
                return e

        error = await asyncio.to_thread(_do)
        if error is None:
            break  # успішно відправлено

        elapsed = time.time() - start_time
        if elapsed >= NOTIFY_MAX_TOTAL_TIME:
            logging.error("web_notify: вичерпано час очікування: %s", error)
            break

        delay = NOTIFY_RETRY_DELAYS[min(attempt, len(NOTIFY_RETRY_DELAYS) - 1)]
        logging.warning(
            "web_notify: спроба %d не вдалася, повтор через %.0fs: %s",
            attempt + 1, delay, error
        )
        await asyncio.sleep(delay)
        attempt += 1

# ───────────────── Telegram handlers ─────────────────
@router.message(Command("start"))
async def cmd_start(m: Message):
    if await _skip_if_blocked(m):
        return
    await m.answer(
        f"👋 Бот моніторингу живлення ЖК 4U з {schedule_link('графіками')} відключень YASNO.\n"
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
        outage_text = f"⚠️ Не вдалося отримати {schedule_link('графік')}"
        restore_text = f"⚠️ Не вдалося отримати {schedule_link('графік')}"

    secs = listener.seconds_since_last_packet()
    power_down = secs > threshold_sec
    now_ts = time.time()

    # Визначаємо тривалість поточного стану
    duration_str = ""
    try:
        if power_down:
            active_outage = await db.get_active_outage()
            if active_outage and active_outage.get("start_ts"):
                duration = now_ts - active_outage["start_ts"]
                duration_str = fmt_duration_long(duration)
        else:
            last_restore_ts = await db.get_last_restore_ts()
            if last_restore_ts:
                duration = now_ts - last_restore_ts
                duration_str = fmt_duration_long(duration)
    except Exception as e:
        logging.error("cmd_status duration error: %s", e)

    if power_down:
        state = f"❌ світла немає {duration_str}" if duration_str else "❌ світла немає"
    else:
        state = f"✅ світло є вже {duration_str}" if duration_str else "✅ світло є"
    schedule_text = restore_text if power_down else outage_text

    await m.answer(f"{state}\n{schedule_text}")

@router.message(Command("today"))
async def cmd_today(m: Message):
    if await _skip_if_blocked(m):
        return
    try:
        outages_info = await asyncio.to_thread(yasno.get_today_outages)
        message = with_last_schedule_update(build_today_message(outages_info), outages_info)
        await m.answer(message)
    except Exception as e:
        logging.error("cmd_today error: %s", e)
        await m.answer(f"❌ Помилка при завантаженні {schedule_link('графіку')}")

@router.message(Command("tomorrow"))
async def cmd_tomorrow(m: Message):
    if await _skip_if_blocked(m):
        return
    try:
        outages_info = await asyncio.to_thread(yasno.get_tomorrow_outages)
        await m.answer(with_last_schedule_update(build_today_message(outages_info), outages_info))
    except Exception as e:
        logging.error("cmd_tomorrow error: %s", e)
        await m.answer(f"❌ Помилка при завантаженні {schedule_link('графіку')}")


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
    await m.answer(f"🧪 Готуємо скріншот {schedule_link('графіка')} на {scope_label}…")

    try:
        outages_info = await asyncio.to_thread(
            yasno.get_today_outages if scope == "today" else yasno.get_tomorrow_outages
        )
    except Exception as error:
        logging.error("testscreenshot fetch error (%s): %s", scope, error)
        await m.answer(f"❌ Не вдалося отримати {schedule_link('графік')} на {scope_label}.")
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


@router.message()
async def handle_silent_chat_messages(m: Message):
    """Видаляє всі повідомлення у silent чатах (крім адміністраторів та адмін-чату/юзера)."""
    chat = m.chat
    if chat is None:
        return
    # В адмін-чаті дозволяємо писати
    if chat.id == ADMIN_LOG_CHAT_ID:
        return
    thread_id = m.message_thread_id
    if not _is_chat_silent(chat.id, thread_id):
        return
    # Адміни та адмін-юзер можуть писати
    user = m.from_user
    if user:
        if user.id == ADMIN_LOG_CHAT_ID:
            return
        if await _is_user_admin(m.bot, chat.id, user.id):
            return
    try:
        await m.delete()
    except Exception as e:
        logging.warning("Не вдалося видалити повідомлення у silent chat=%s thread=%s: %s", chat.id, thread_id, e)


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
                old_status, old_slots = last_today_signature or (None, ())
                same_empty_schedule = (
                    _is_schedule_without_outages(old_status, old_slots)
                    and _is_schedule_without_outages(status, slots_signature)
                )
                last_today_signature = current_signature
                persist_required = True
                if not same_empty_schedule:
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
                        f"🔔 {schedule_link('Графік на сьогодні')} оновлено!\n\n{message_body}",
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
                if old_status == STATUS_WAITING_FOR_SCHEDULE and is_published_schedule(current_status):
                    # З'явився графік, зокрема порожній: ScheduleApplies без слотів або NoOutages.
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
                        f"🔔 З'явився {schedule_link('графік на завтра')}!\n\n{message_body}",
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
                    # Отримуємо час останнього відновлення для підрахунку тривалості світла
                    uptime_line = ""
                    try:
                        last_restore_ts = await db.get_last_restore_ts()
                        if last_restore_ts is not None:
                            uptime_seconds = max(0.0, start_ts - last_restore_ts)
                            uptime_line = f"Час зі світлом: {fmt_duration_long(uptime_seconds)}"
                    except Exception as e:
                        logging.error("Failed to get last restore ts: %s", e)
                    try:
                        now_dt = datetime.fromtimestamp(now, tz=TZ)
                        restore_msg = await asyncio.to_thread(yasno.get_nearest_restore_message, now_dt)
                        body_lines = ["🔔⚠️ Світло ЗНИКЛО."]
                        if uptime_line:
                            body_lines.append(uptime_line)
                        body_lines.append(restore_msg)
                        await notify(bot, "\n".join(body_lines))
                        asyncio.create_task(web_notify({
                            "type": "power_outage_started",
                            "category": "actual",
                            "title": "⚠️ Світло зникло",
                            "body": "\n".join([uptime_line, restore_msg] if uptime_line else [restore_msg]),
                            "data": {
                                "networkState": "off",
                                "tag": "power-status",
                                "planMessage": restore_msg,
                            },
                        }))
                    except Exception as e:
                        logging.error("Failed to get restore message: %s", e)
                        body_lines = ["⚠️ Світло ЗНИКЛО."]
                        if uptime_line:
                            body_lines.append(uptime_line)
                        await notify(bot, "\n".join(body_lines))
                        asyncio.create_task(web_notify({
                            "type": "power_outage_started",
                            "category": "actual",
                            "title": "Світло зникло",
                            "body": uptime_line,
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
                        f"Час без світла: {fmt_duration_long(downtime)}",
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

    bot = Bot(
        BOT_TOKEN,
        default=DefaultBotProperties(
            parse_mode="HTML",
            link_preview_is_disabled=True,
        ),
    )
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
