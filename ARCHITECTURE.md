# Архітектура бота моніторингу живлення — Ключова логіка

> Документ описує логіку роботи поточного Telegram-бота (`bot.py`) та супутніх модулів
> з метою подальшої міграції на FastAPI-сервер.
> Специфіка бібліотек (aiogram, requests тощо) опущена — зосередження на **алгоритмах і потоках даних**.

---

## 1. Загальна архітектура

```
┌─────────────┐    UDP heartbeat     ┌──────────────────────────┐
│  ESP32      │ ────────────────────▶ │  UDPListener             │
│  (датчик)   │     кожні ~1с        │  (фоновий потік)         │
└─────────────┘                      └──────────┬───────────────┘
                                                │ last_packet_time
                                                ▼
                                     ┌──────────────────────────┐
                                     │  bot.py (головний процес)│
                                     │                          │
                                     │  ┌── power_monitor ──┐   │
                                     │  │ (кожну 1с)        │   │◀── Telegram команди
                                     │  └───────────────────┘   │    (/status, /today, /tomorrow)
                                     │                          │
                                     │  ┌── schedule_monitor ─┐ │
                                     │  │ (кожні 60с)         │ │──▶ Telegram сповіщення
                                     │  └─────────────────────┘ │──▶ Web notify (SSE/Push)
                                     │                          │
                                     │  ┌── schedule_tomorrow ┐ │
                                     │  │ (кожні 61с)         │ │
                                     │  └─────────────────────┘ │
                                     │                          │
                                     │  ┌── reminder_scheduler┐ │
                                     │  │ (кожні 20с)         │ │
                                     │  └─────────────────────┘ │
                                     └──────────┬───────────────┘
                                                │
                                                ▼
                                     ┌──────────────────────────┐
                                     │  SQLite (storage.py)     │
                                     │  - outages (факт)        │
                                     │  - schedules (план)      │
                                     └──────────────────────────┘
```

### Компоненти

| Модуль | Роль |
|---|---|
| `bot.py` | Основна точка входу: Telegram-бот + 4 фонові цикли |
| `yasno_outages.py` | Парсинг API Yasno: розклад відключень на сьогодні/завтра, повідомлення про найближчі події |
| `storage.py` | SQLite-обгортка: логування фактичних відключень і кешування розкладів |
| `udp_listener.py` | UDP-приймач heartbeat-пакетів від ESP32 (індикатор наявності живлення) |
| `maintenance_bot.py` | Заглушка: відповідає "тех. роботи" на всі команди (при деплої основного бота) |
| `scripts/render_timeline_screenshot.py` | Playwright-скрипт: знімає скріншот розкладу з web-app для вкладення в повідомлення |

---

## 2. Конфігурація (env-змінні)

| Змінна | Призначення |
|---|---|
| `BOT_TOKEN` | Токен Telegram-бота |
| `YASNO_GROUP` | Група відключень Yasno (напр. `"12.1"`) |
| `ADMIN_LOG_CHAT_ID` | Чат для адмін-логів |
| `ALERT_CHAT_ID` | Цільові чати для сповіщень (формат: `chat_id` або `chat_id_thread_id`, через кому) |
| `BLOCK_ALERT_CHAT_ID` | Чати, де бот ігнорує команди й видаляє повідомлення |
| `SILENT_CHAT_ID` | Чати, де видаляються всі не-адмінські повідомлення |
| `UDP_PORT` | Порт для UDP heartbeat (за замовч. `5005`) |
| `THRESHOLD_SEC` | Поріг "немає пакетів" = "немає світла" (за замовч. `6` сек) |
| `WEB_NOTIFY_URL` | URL для сповіщення web-app (SSE + Push) |
| `NOTIFY_BOT_TOKEN` | Токен авторизації для web notify |
| `TIMELINE_SCREENSHOT_ENABLED` | Чи генерувати скріншоти розкладу |
| `DB_PATH` | Шлях до SQLite БД |

---

## 3. Визначення стану живлення (UDPListener)

### Принцип

ESP32, підключений до електромережі, шле UDP-пакети кожну ~1 секунду на сервер.

```
seconds_since_last_packet():
  якщо пакетів ще не було → повертає Infinity
  інакше → (поточний_час - час_останнього_пакета)
```

### Визначення стану

```
power_down = seconds_since_last_packet() > THRESHOLD_SEC (6 сек)
```

**Особливий випадок при старті бота**: якщо пакетів ще не було (`Infinity`) і з моменту запуску пройшло більше `THRESHOLD_SEC`, вважаємо що світла немає з моменту запуску.

---

## 4. Фоновий цикл: Power Monitor (`power_monitor`)

**Інтервал:** кожну 1 секунду

### Алгоритм

```
Кожну секунду:
  1. Визначити стан живлення (power_down = secs > threshold)
  
  2. Визначити початок відключення:
     - якщо secs == Infinity і (now - startup_ts) > threshold:
         outage_detected = true
         outage_start = startup_ts
     - якщо secs > threshold:
         outage_detected = true
         outage_start = now - secs
     - інакше:
         outage_detected = false
  
  3. Отримати активне відключення з БД (active_outage)
  
  4. Якщо ВИЯВЛЕНО відключення і в БД НЕМАЄ активного:
     → Записати outage_start в БД
     → Обчислити uptime (час зі світлом від останнього відновлення)
     → Отримати повідомлення "коли буде відновлено" з графіка
     → Надіслати Telegram + Web сповіщення:
       "⚠️ Світло ЗНИКЛО."
       "Час зі світлом: X год. Y хв."
       "За графіком світло має відновитися о HH:MM."
  
  5. Якщо НЕ виявлено відключення і в БД Є активне (і secs != Infinity):
     → Закрити відключення в БД (записати end_ts)
     → Обчислити downtime (тривалість відключення)
     → Отримати повідомлення "коли наступне відключення" з графіка
     → Надіслати Telegram + Web сповіщення:
       "✅ Світло ВІДНОВЛЕНО."
       "Час без світла: X год. Y хв."
       "Найближче відключення о HH:MM."
```

### Retry-логіка відправки

Якщо відправка повідомлення не вдається (немає інтернету):
- Затримки між спробами: `5, 10, 15, 30, 60, 120, 180` секунд
- Максимальний час очікування: `1800` секунд (30 хвилин)
- Застосовується і для Telegram, і для web notify

---

## 5. Фоновий цикл: Schedule Monitor Today (`schedule_monitor`)

**Інтервал:** кожні 60 секунд

### Алгоритм

```
Кожні 60 секунд:
  1. Отримати графік на сьогодні від Yasno API
  
  2. Побудувати "сигнатуру" поточного стану:
     signature = (status, tuple_of_slots)
     де slot = (start_min, end_min, type)
  
  3. Якщо це ПЕРШИЙ запуск:
     → Зберегти сигнатуру як базову
     → Зберегти графік в БД
     → НЕ сповіщувати
  
  4. Якщо ЗМІНИЛАСЯ дата (перехід доби):
     → Оновити базову сигнатуру
     → Зберегти графік в БД
     → НЕ сповіщувати (перехід доби не є зміною графіка)
  
  5. Якщо сигнатура ЗМІНИЛАСЯ (та ж дата):
     → Зберегти графік в БД
     → Згенерувати скріншот
     → Надіслати сповіщення:
       "🔔 Графік на сьогодні оновлено!"
       + деталі графіка
       + скріншот (якщо вдалося згенерувати)
```

---

## 6. Фоновий цикл: Schedule Monitor Tomorrow (`schedule_monitor_tomorrow`)

**Інтервал:** кожні 61 секунду

### Алгоритм

Аналогічний до `schedule_monitor`, але з ключовою відмінністю:

```
Сповіщення відправляється ТІЛЬКИ коли:
  - статус змінився з "WaitingForSchedule" на "ScheduleApplies"
    (= графік на завтра щойно опублікували)

НЕ сповіщується:
  - При зміні слотів у вже опублікованому графіку
  - При переході доби
  - При першому запуску
```

Повідомлення: `"🔔 З'явився графік на завтра!"` + деталі + скріншот

---

## 7. Фоновий цикл: Reminder Scheduler (`reminder_scheduler`)

**Інтервал:** кожні 20 секунд

### Призначення

Надсилає **web push нагадування** за `N` хвилин до початку/закінчення запланованих відключень.

### Конфігурація

```
REMINDER_LEADS = (10, 20, 30, 60)       # за скільки хвилин нагадувати
TRIGGER_WINDOW_SEC = 45                   # вікно спрацьовування (±45 сек)
HISTORY_TTL_SEC = 6 * 3600               # скільки зберігати історію відправок
```

### Алгоритм

```
Кожні 20 секунд:
  1. Отримати графіки на сьогодні + завтра
  
  2. Витягти всі сегменти відключень (start, end) з обох днів
     Тільки зі статусами "ScheduleApplies" або "EmergencyShutdowns"
     Тільки слоти де is_outage = true
  
  3. Для кожного сегмента і кожного lead (10, 20, 30, 60 хв):
     - Обчислити trigger_outage = start - lead_minutes
     - Обчислити trigger_restore = end - lead_minutes
     → Це дає список ReminderEvent
  
  4. Для кожного ReminderEvent:
     a) Перевірити чи НЕ вже відправлено (history по ключу kind:start_iso:lead)
     b) Перевірити чи зараз у вікні спрацьовування (0..45 сек після trigger_at)
     c) "Розумна" фільтрація:
        - Якщо kind="outage" і вже НЕМАЄ СВІТЛА → пропустити (не має сенсу)
        - Якщо kind="restore" і світло Є → пропустити
     d) Якщо всі перевірки пройдені → відправити web push і записати в history
  
  5. Очистити старі записи з history (TTL = 6 годин)
```

### Формат нагадування (тільки web push, без Telegram)

```
Відключення за 30 хв:
  title: "⏳ Відключення за 30 хв"
  body:  "Світло є, але за 30 хв почнеться планове відключення."

Відновлення за 10 хв:
  title: "⏳ Відновлення за 10 хв"
  body:  "Світла немає, але за 10 хв має відновитися згідно графіка."
```

---

## 8. Парсинг графіка Yasno (`yasno_outages.py`)

### API endpoint

```
GET https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/{region_id}/dsos/{dso_id}/planned-outages
```

Повертає JSON з ключами — ідентифікаторами груп (напр. `"12.1"`).
Кожна група містить об'єкти `today` та `tomorrow`.

### Структура відповіді API (релевантна частина)

```json
{
  "12.1": {
    "today": {
      "date": "2025-06-15",
      "status": "ScheduleApplies",   // або "WaitingForSchedule", "EmergencyShutdowns"
      "slots": [
        { "start": 0, "end": 360, "type": "NotPlanned" },
        { "start": 360, "end": 720, "type": "Definite" },
        { "start": 720, "end": 1080, "type": "Possible" },
        { "start": 1080, "end": 1440, "type": "NotPlanned" }
      ]
    },
    "tomorrow": { ... }
  }
}
```

### Slot (модель)

```
Slot:
  start_min: int      — початок у хвилинах від 00:00
  end_min: int         — кінець у хвилинах від 00:00 (невключно)
  type: str            — "Definite" | "Possible" | "NotPlanned"
  
  is_outage = (type != "NotPlanned")
  
  as_time_range(date, tz) → (datetime_start, datetime_end)
```

### Статуси дня

| Статус | Значення |
|---|---|
| `ScheduleApplies` | Графік діє, слоти актуальні |
| `WaitingForSchedule` | Графік ще не опубліковано |
| `EmergencyShutdowns` | Екстрені відключення, графік не діє |

### Ключові методи

#### `get_today_outages()` / `get_tomorrow_outages()`

```
1. Запит до API (або використання data_override)
2. Витяг блоку групи
3. Для кожного дня:
   - Парсинг слотів
   - Якщо status == "ScheduleApplies":
     → Для кожного слота з is_outage == true
       → Перетворити (start_min, end_min) у (datetime_start, datetime_end)
   - Повернути: { date, status, outages: [{start, end, type}], raw_slots }
```

#### `get_nearest_restore_message(now)`

Повертає текстове повідомлення про те, коли очікується відновлення світла.

```
Пріоритети (перший знайдений):

1. Якщо статус "EmergencyShutdowns":
   → "Діють екстрені відключення. Графік не діє."

2. Збір УСІХ слотів-відключень з today + tomorrow:
   - Майбутні (end > now) → список `slots`
   - Минулі (end <= now) → список `past_outages`

3. Перевірка "зараз в межах відключення" (з допуском 45 хв раннього старту):
   - Якщо знайдено → "За графіком світло має відновитися о HH:MM."
   - При цьому суміжні інтервали об'єднуються (extended_end)

4. Перевірка "є майбутнє відключення, що скоро почнеться" (90 хв):
   → "За графіком світло має відновитися о HH:MM." (end майбутнього)

5. Перевірка минулих відключень (затримка відновлення до 90 хв):
   → "За графіком світло мало відновитися о HH:MM."

6. Fallback:
   → "Відключення поза графіком/можливо аварійні."
```

#### `get_nearest_outage_message(now)`

Повертає текстове повідомлення про найближче заплановане відключення.

```
Пріоритети:

1. "EmergencyShutdowns" → відповідне повідомлення

2. Якщо обидва дні НЕ мають "ScheduleApplies":
   - "WaitingForSchedule" → "Графік ще не опубліковано"
   - Інше → "Графік недоступний"

3. Збір майбутніх стартів відключень з today + tomorrow

4. Якщо є майбутні:
   - Якщо найближчий — завтра → "Найближче відключення завтра о HH:MM"
   - Інакше → "Найближче відключення о HH:MM"

5. Перевірка минулих "мало відбутися" (90 хв grace):
   → "Відключення мало відбутися о HH:MM, очікуйте"

6. Fallback:
   → "Сьогодні відключень не передбачено"
```

#### `get_nearest_outage(now)` → `datetime | None`

Повертає `datetime` початку найближчого відключення. Якщо зараз всередині відключення — повертає його старт.

---

## 9. Зберігання даних (`storage.py`)

### Таблиці SQLite

#### `outages` — фактичні відключення

```sql
CREATE TABLE outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts REAL NOT NULL,       -- Unix timestamp початку
    end_ts REAL,                  -- Unix timestamp закінчення (NULL = активне)
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
```

#### `schedules` — кешовані графіки

```sql
CREATE TABLE schedules (
    schedule_date TEXT PRIMARY KEY,  -- ISO дата (YYYY-MM-DD)
    status TEXT,                     -- статус дня (ScheduleApplies, ...)
    outages_json TEXT,               -- JSON масив відключень
    slots_json TEXT,                 -- JSON масив слотів
    updated_at REAL NOT NULL
);
```

### Ключові операції

| Метод | Логіка |
|---|---|
| `log_outage_start(ts)` | Якщо є відкрите відключення — оновлює start_ts (якщо новий менший). Інакше — створює новий запис |
| `log_outage_end(ts)` | Знаходить відкрите відключення, записує end_ts, повертає start_ts для розрахунку тривалості |
| `get_active_outage()` | Повертає останнє відключення де end_ts IS NULL |
| `get_last_restore_ts()` | Повертає end_ts останнього ЗАКРИТОГО відключення (час відновлення) |
| `upsert_schedule(date, status, outages, slots)` | INSERT OR UPDATE графіка на дату |
| `get_push_subscriptions_count()` | Читає кількість підписок з окремої БД `push_subs.db` (read-only) |

---

## 10. Telegram-команди

| Команда | Логіка |
|---|---|
| `/start` | Вітальне повідомлення з групою Yasno |
| `/status` | Поточний стан: "✅ світло є вже X год." або "❌ світла немає X год." + інфо про найближчу подію з графіка. Логує запит в адмін-чат |
| `/today` | Графік відключень на сьогодні з Yasno API |
| `/tomorrow` | Графік відключень на завтра |
| `/testscreenshot` | (тільки адмін) Тест генерації скріншоту |
| `/notifyweb` | (тільки адмін) Ручна відправка web push сповіщення |
| `/subcount` | (тільки адмін) Кількість PWA push підписок |

### Механізм блокування чатів

```
Для кожної команди:
  1. Перевірити чи chat_id + thread_id є в BLOCKED → ігнорувати + видалити
  
Для усіх повідомлень (не-команд):
  2. Якщо chat_id + thread_id є в SILENT:
     → Якщо автор НЕ адмін і НЕ адмін-чат → видалити повідомлення
```

---

## 11. Система сповіщень

### Telegram notify

```
Для кожного (chat_id, thread_id) з ALERT_CHAT_TARGETS:
  - Якщо є фото (скріншот) → send_photo з caption
  - Інакше → send_message
  - Retry з прогресивними затримками при помилці
```

### Web notify

```
POST {WEB_NOTIFY_URL}
Headers: Content-Type: application/json, x-bot-token: {NOTIFY_BOT_TOKEN}
Body (JSON):
  {
    "type": "power_outage_started" | "power_restored" | "schedule_updated" | "reminder",
    "category": "actual" | "schedule_change" | "reminder",
    "title": "...",
    "body": "...",
    "data": { ... додаткові дані ... }
  }
```

Перед відправкою з тексту body видаляються HTML-посилання (`<a href>` → лише текст).

Retry-логіка аналогічна Telegram notify.

---

## 12. Формат chat targets (env)

```
Формат: CHAT_ID або CHAT_ID_THREAD_ID, розділені комами/пробілами

Приклади:
  "-1001234567890"                    → чат без треда
  "-1001234567890_123"                → чат з тредом 123
  "-1001234567890,-1009876543210_456" → кілька цілей
```

---

## 13. Життєвий цикл програми

```
main():
  1. Ініціалізація logging, перевірка BOT_TOKEN
  2. Створення бота з конфігурацією (HTML parse_mode, no link preview)
  3. Реєстрація lifecycle-хуків
  
on_startup():
  1. startup_ts = now
  2. UDPListener.start() — старт прийому пакетів
  3. Запуск фонових задач:
     - power_monitor (кожну 1с)
     - schedule_monitor (кожні 60с)
     - schedule_monitor_tomorrow (кожні 61с)
     - reminder_scheduler (кожні 20с)
  
on_shutdown():
  1. Скасування всіх фонових задач
  2. UDPListener.stop()
  3. Database.close()
```

---

## 14. Скріншоти графіка

При зміні графіка або за запитом адміна:

```
1. Запуск окремого Python-процесу (Playwright)
2. Відкриття web-app URL з параметрами (?botToken=...&scope=today|tomorrow)
3. Очікування завантаження сторінки (networkidle)
4. Знаходження елемента [data-testid=snake-day-timeline]
5. Скріншот елемента → PNG файл у тимчасову директорію
6. Повернення шляху до файлу
7. Після відправки — видалення тимчасового файлу
```

---

## 15. Ключові grace-параметри (Yasno)

| Параметр | Значення | Призначення |
|---|---|---|
| `early_start_grace_minutes` | 45 | Допуск раннього початку відключення |
| `missed_start_grace_minutes` | 90 | Скільки часу показувати "мало відбутися" після запланованого старту |
| `restore_delay_grace_minutes` | 90 | Допустима затримка відновлення |

---

## 16. Maintenance Bot

Окремий мінімальний бот (`maintenance_bot.py`) для деплою основного:

```
На команди /start, /status, /today, /tomorrow:
  → Відповідь: "Бот тимчасово недоступний, проводяться технічні роботи."

На callback query:
  → answer() + те саме повідомлення
```

---

## 17. Рекомендації для міграції на FastAPI

### Що зберегти як є (логіка)

1. **Power Monitor** — цикл визначення стану живлення за UDP heartbeat
2. **Schedule Monitor** — polling Yasno API + порівняння сигнатур
3. **Reminder Scheduler** — обчислення trigger-подій та дедуплікація
4. **YasnoOutages** — повний клас парсингу API та формування повідомлень
5. **Database** — схема та операції (замінити sqlite на async-альтернативу або залишити)
6. **Retry-логіка** — прогресивні затримки для відправки сповіщень
7. **Формат chat targets** — парсинг env-змінних

### Що замінити

| Було | Стане |
|---|---|
| aiogram Telegram bot | FastAPI endpoints + background tasks |
| `dp.start_polling()` | `uvicorn` / `hypercorn` |
| Telegram команди (`/status`, `/today`) | REST endpoints (`GET /status`, `GET /today`) |
| `notify(bot, text)` | Абстракція: push до черги або webhook |
| `asyncio.create_task()` для фонових циклів | FastAPI `lifespan` або `on_event("startup")` |
| `aiogram.types.FSInputFile` | `FileResponse` або прямий upload |

### Структура FastAPI сервера (орієнтовна)

```
app/
  main.py              — FastAPI app + lifespan (старт/зупинка фонових задач)
  config.py            — конфігурація з env
  routers/
    status.py          — GET /status, GET /today, GET /tomorrow
    admin.py           — POST /notify, GET /subcount
    webhooks.py        — POST /power-event (від зовнішніх джерел)
  services/
    power_monitor.py   — фоновий цикл моніторингу живлення
    schedule_monitor.py — фонові цикли моніторингу графіків
    reminder.py        — фоновий цикл нагадувань
    yasno.py           — YasnoOutages (без змін)
    notifier.py        — абстракція сповіщень (Telegram, Web Push, SSE)
  models/
    database.py        — storage.py (адаптований)
    schemas.py         — Pydantic моделі
  udp_listener.py      — без змін
```
