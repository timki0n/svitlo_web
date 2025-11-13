import os
import re
import asyncio
import logging
import time
import contextlib
import json
import urllib.request
import urllib.error
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Final

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
UDP_PORT = int(os.getenv("UDP_PORT", "5005"))
DEFAULT_THRESHOLD_SEC = float(os.getenv("THRESHOLD_SEC", "6"))
SCHEDULE_POLL_INTERVAL_SEC = 60
WEB_NOTIFY_URL = os.getenv("WEB_NOTIFY_URL", "http://127.0.0.1:3000/api/notify")
NOTIFY_BOT_TOKEN = os.getenv("NOTIFY_BOT_TOKEN", "")

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

# ───────────────── helpers ─────────────────
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


async def notify(bot: Bot, text: str):
    if not ALERT_CHAT_TARGETS:
        return
    for chat_id, thread_id in ALERT_CHAT_TARGETS:
        try:
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

@router.message(Command("status"))
async def cmd_status(m: Message):
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
    try:
        outages_info = await asyncio.to_thread(yasno.get_today_outages)
        message = build_today_message(outages_info)
        await m.answer(message)
    except Exception as e:
        logging.error("cmd_today error: %s", e)
        await m.answer("❌ Помилка при завантаженні графіку")

@router.message(Command("tomorrow"))
async def cmd_tomorrow(m: Message):
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
                await notify(bot, f"🔔 Графік на сьогодні оновлено!\n\n{message_body}")
                asyncio.create_task(web_notify({
                    "type": "schedule_updated",
                    "title": "Оновлено графік на сьогодні",
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
                await notify(bot, f"🔔 З'явився графік на завтра!\n\n{message_body}")
                asyncio.create_task(web_notify({
                    "type": "schedule_updated",
                    "title": "Оновлено графік на завтра",
                    "body": message_body,
                }))

            await asyncio.sleep(SCHEDULE_POLL_INTERVAL_SEC + 1)
        except asyncio.CancelledError:
            break
        except Exception:
            logging.exception("Schedule monitor tomorrow error")
            await asyncio.sleep(SCHEDULE_POLL_INTERVAL_SEC)

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
                            "title": "Світло зникло",
                            "body": restore_msg,
                        }))
                    except Exception as e:
                        logging.error("Failed to get restore message: %s", e)
                        await notify(bot, "⚠️ Світло ЗНИКЛО.")
                        asyncio.create_task(web_notify({
                            "type": "power_outage_started",
                            "title": "Світло зникло",
                            "body": "",
                        }))
            else:
                if active_outage is not None and secs != float("inf"):
                    start_ts = await db.log_outage_end(now)
                    effective_start = start_ts if start_ts is not None else now
                    downtime = max(0.0, now - effective_start)
                    await notify(
                        bot,
                        f"🔔✅ Світло ВІДНОВЛЕНО.\n"
                        f"Час без світла: {fmt_duration(downtime)}",
                    )
                    asyncio.create_task(web_notify({
                        "type": "power_restored",
                        "title": "Світло відновлено",
                        "body": f"Час без світла: {fmt_duration(downtime)}",
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
    print("[startup] UDP listener started, monitor and schedule tasks running")

async def on_shutdown(dispatcher: Dispatcher, bot: Bot):
    # акуратно гасимо фоновий таск монітора
    for key in ("monitor_task", "schedule_task", "schedule_tomorrow_task"):
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
