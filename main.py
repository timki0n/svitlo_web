import asyncio
import os
import sys
import signal
import socket
from datetime import datetime, timezone, timedelta

from aiogram import Bot, Dispatcher, Router, F
from aiogram.types import Message
from aiogram.filters import Command
from aiogram.enums import ParseMode

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# ===== Config =====
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
CHAT_ID = int(os.getenv("CHAT_ID", "0"))
BT_ADDR = os.getenv("BT_ADDR", "").strip()               # e.g. "AA:BB:CC:DD:EE:FF"
BT_CHANNEL = int(os.getenv("BT_CHANNEL", "1"))
NO_MSG_TIMEOUT_SEC = int(os.getenv("NO_MSG_TIMEOUT_SEC", "10"))
RECONNECT_DELAY_SEC = int(os.getenv("RECONNECT_DELAY_SEC", "5"))

if not BOT_TOKEN or not CHAT_ID or not BT_ADDR:
    print("Please set BOT_TOKEN, CHAT_ID, BT_ADDR (and optionally BT_CHANNEL) env vars.", file=sys.stderr)
    sys.exit(1)

# ===== Helpers =====
def now_utc():
    return datetime.now(timezone.utc)

def humanize_td_uk(td: timedelta) -> str:
    # Приблизна людина-зрозуміла тривалість: год, хв, сек
    total_seconds = int(td.total_seconds())
    if total_seconds < 0:
        total_seconds = 0
    hours, rem = divmod(total_seconds, 3600)
    minutes, seconds = divmod(rem, 60)

    parts = []
    if hours > 0:
        parts.append(f"{hours} год.")
    if minutes > 0:
        parts.append(f"{minutes} хв.")
    if hours == 0 and minutes == 0:
        parts.append(f"{seconds} сек.")
    return " ".join(parts)

# ===== Bluetooth RFCOMM connector/reader =====
class BTReader:
    """
    Підключається по RFCOMM до ESP32 SPP та читає bytes.
    Кидає у asyncio.Queue всі отримані фрагменти (нам достатньо факту приходу).
    """
    def __init__(self, addr: str, channel: int, queue: asyncio.Queue, reconnect_delay: int = 5):
        self.addr = addr
        self.channel = channel
        self.queue = queue
        self.reconnect_delay = reconnect_delay

        self._sock: socket.socket | None = None
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    async def start(self):
        self._stopped.clear()
        self._task = asyncio.create_task(self._run(), name="bt-reader")

    async def stop(self):
        self._stopped.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._close_sock()

    def _close_sock(self):
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        self._sock = None

    async def _run(self):
        # Луп перепідключення
        while not self._stopped.is_set():
            try:
                # Створюємо RFCOMM сокет (Bluetooth Classic SPP)
                # Пакет pybluez під капотом додає протоколи, але тут використовуємо стандартний socket з AF_BLUETOOTH якщо доступно
                import bluetooth  # pybluez
                self._close_sock()
                self._sock = bluetooth.BluetoothSocket(bluetooth.RFCOMM)
                self._sock.settimeout(5.0)
                self._sock.connect((self.addr, self.channel))
                # Після конекту читаємо неблокуюче
                self._sock.settimeout(1.0)

                # Основний read-луп поки не зупинено
                while not self._stopped.is_set():
                    try:
                        data = self._sock.recv(1024)
                        if not data:
                            # Розрив з'єднання
                            raise ConnectionError("Remote closed")
                        # Скидаємо будь-який payload у чергу (досить факту)
                        await self.queue.put((now_utc(), data))
                    except socket.timeout:
                        # Нормально: просто немає нового пакета в цей момент
                        continue
                    except OSError as e:
                        # Будь-яка інша помилка — пробуємо перепідключитись
                        raise ConnectionError(str(e)) from e
            except Exception:
                # Від'єдналося або не підключилось — пауза та ще раз
                self._close_sock()
                if self._stopped.is_set():
                    break
                await asyncio.sleep(self.reconnect_delay)

# ===== Power state machine =====
class PowerMonitor:
    """
    Визначає стани:
      - "power_on" (пакети надходять)
      - "power_off" (пакети зникли більше ніж на NO_MSG_TIMEOUT_SEC)
    Генерує нотифікації тільки при зміні стану.
    """
    def __init__(self, bot: Bot, chat_id: int, timeout_sec: int):
        self.bot = bot
        self.chat_id = chat_id
        self.timeout = timedelta(seconds=timeout_sec)

        self.state = "unknown"   # "power_on" | "power_off" | "unknown"
        self.last_packet_at: datetime | None = None
        self.outage_started_at: datetime | None = None

        self._watchdog_task: asyncio.Task | None = None
        self._queue = asyncio.Queue()  # заповнює BTReader

    def get_queue(self) -> asyncio.Queue:
        return self._queue

    async def start(self):
        self._watchdog_task = asyncio.create_task(self._watchdog(), name="power-watchdog")

    async def stop(self):
        if self._watchdog_task:
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass

    async def _notify(self, text: str):
        try:
            await self.bot.send_message(self.chat_id, text, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
        except Exception as e:
            # Лише лог у консоль, щоб не падати
            print(f"[notify error] {e}", file=sys.stderr)

    async def _on_packet(self, ts: datetime, data: bytes):
        self.last_packet_at = ts
        # Якщо були у "power_off" – значить світло повернулось
        if self.state == "power_off":
            # обчислюємо тривалість
            if self.outage_started_at:
                dur = self.last_packet_at - self.outage_started_at
                human = humanize_td_uk(dur)
                await self._notify(f"✅ <b>Світло відновлено</b>\nТривалість відключення: ~{human}")
            else:
                await self._notify("✅ <b>Світло відновлено</b>")
            self.state = "power_on"
            self.outage_started_at = None
        elif self.state in ("unknown",):
            # Перше надходження — вважаємо, що світло є
            self.state = "power_on"

    async def _watchdog(self):
        # Паралельно споживаємо пакети та перевіряємо таймаут
        while True:
            # Чекаємо або пакет, або таймаут
            try:
                # таймаут невеличкий, щоб регулярно перевіряти стан
                pkt_task = asyncio.create_task(self._queue.get())
                done, _ = await asyncio.wait({pkt_task}, timeout=1.0)
                if pkt_task in done:
                    ts, data = pkt_task.result()
                    await self._on_packet(ts, data)
                # Перевірка відсутності пакетів
                await self._check_timeout()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[watchdog] {e}", file=sys.stderr)

    async def _check_timeout(self):
        # Якщо вже power_off — нічого не дублюємо
        if self.state == "power_off":
            return
        # Якщо ще жодного пакета — чекаємо
        if not self.last_packet_at:
            return
        # Чи вийшов таймаут?
        if now_utc() - self.last_packet_at > self.timeout:
            # Переходимо у "power_off" та алертимо один раз
            self.state = "power_off"
            self.outage_started_at = self.last_packet_at
            await self._notify("❌ <b>Світло зникло</b>\n(немає даних від датчика)")

    # Публічні методи для команд
    def status_text(self) -> str:
        if self.state == "power_on":
            last = self.last_packet_at.astimezone().strftime("%Y-%m-%d %H:%M:%S")
            return f"ℹ️ Стан: <b>є світло</b>\nОстанній пакет: {last} локального часу"
        if self.state == "power_off":
            if self.outage_started_at:
                dur = now_utc() - self.outage_started_at
                human = humanize_td_uk(dur)
                since = self.outage_started_at.astimezone().strftime("%Y-%m-%d %H:%M:%S")
                return f"ℹ️ Стан: <b>світла немає</b>\nБез світла: ~{human}\nЗникло о: {since} локального часу"
            return "ℹ️ Стан: <b>світла немає</b>"
        return "ℹ️ Стан: <i>невідомо</i> (ще не отримували пакети)"

# ===== Telegram bot (Aiogram v3) =====
router = Router()

@router.message(Command("ping"))
async def cmd_ping(message: Message):
    await message.answer("🏓 Я на звʼязку.")

@router.message(Command("status"))
async def cmd_status(message: Message, power: PowerMonitor):
    await message.answer(power.status_text(), parse_mode=ParseMode.HTML, disable_web_page_preview=True)

# ===== Wiring everything together =====
async def main():
    bot = Bot(BOT_TOKEN)
    dp = Dispatcher()

    power = PowerMonitor(bot=bot, chat_id=CHAT_ID, timeout_sec=NO_MSG_TIMEOUT_SEC)
    bt_reader = BTReader(addr=BT_ADDR, channel=BT_CHANNEL, queue=power.get_queue(), reconnect_delay=RECONNECT_DELAY_SEC)

    # Dependency injection для хендлерів
    dp["power"] = power
    dp.include_router(router)

    # Старт сервісних тасків
    await power.start()
    await bt_reader.start()

    # Опційно — повідомити в чат при запуску
    try:
        await bot.send_message(CHAT_ID, "🚀 Бот запущено. Чекаю пакети з датчика ESP32…")
    except Exception:
        pass

    # Акуратне завершення за сигналами
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _graceful(*_):
        stop_event.set()
    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(s, _graceful)
        except NotImplementedError:
            # На Windows може не підтримуватись
            pass

    # Запускаємо прийом апдейтів
    polling_task = asyncio.create_task(dp.start_polling(bot), name="telegram-polling")

    # Чекаємо сигналу завершення
    await stop_event.wait()

    # Штатно зупиняємось
    polling_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await polling_task
    await bt_reader.stop()
    await power.stop()
    await bot.session.close()

# contextlib використовується в main()
import contextlib

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
