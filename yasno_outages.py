from __future__ import annotations
import datetime as dt
from dataclasses import dataclass
from typing import List, Dict, Any, Optional
import requests
from zoneinfo import ZoneInfo

SCHEDULE_URL = "https://svitlo4u.online"

# Опублікований графік зі слотами відключень.
STATUS_SCHEDULE_APPLIES = "ScheduleApplies"
# Опублікований графік без жодного відключення. Те саме, що ScheduleApplies і порожні слоти.
STATUS_NO_OUTAGES = "NoOutages"
STATUS_WAITING_FOR_SCHEDULE = "WaitingForSchedule"
STATUS_EMERGENCY_SHUTDOWNS = "EmergencyShutdowns"

PUBLISHED_SCHEDULE_STATUSES = frozenset({STATUS_SCHEDULE_APPLIES, STATUS_NO_OUTAGES})


def schedule_link(label: str) -> str:
    return f'<a href="{SCHEDULE_URL}">{label}</a>'


def is_published_schedule(status: str | None) -> bool:
    """Графік уже відомий: або діють слоти, або відключень явно немає."""
    return status in PUBLISHED_SCHEDULE_STATUSES


def _missing_schedule_message(today_status: str, tomorrow_status: str) -> str:
    if STATUS_WAITING_FOR_SCHEDULE in (today_status, tomorrow_status):
        return f"⌛ {schedule_link('Графік')} ще не опубліковано"
    return f"⚠️ {schedule_link('Графік')} недоступний."


def _off_schedule_message() -> str:
    return f"Відключення поза {schedule_link('графіком')}/можливо аварійні."


@dataclass(frozen=True)
class Slot:
    start_min: int
    end_min: int     # невключно
    type: str        # "Definite", "Possible", "NotPlanned", ...

    def as_time_range(self, date: dt.date, tz: ZoneInfo) -> tuple[dt.datetime, dt.datetime]:
        start = dt.datetime.combine(date, dt.time.min, tzinfo=tz) + dt.timedelta(minutes=self.start_min)
        end = dt.datetime.combine(date, dt.time.min, tzinfo=tz) + dt.timedelta(minutes=self.end_min)
        return start, end

    @property
    def is_outage(self) -> bool:
        return self.type != "NotPlanned"


class YasnoOutages:
    """
    Планові інтервали беремо лише коли day.status == 'ScheduleApplies'.
    'NoOutages' — опублікований графік без відключень (як ScheduleApplies з порожніми слотами).
    'WaitingForSchedule' та невідомі статуси — графіка ще немає.
    """

    def __init__(self, region_id: int, dso_id: int, group_id: str, tz_name: str = "Europe/Kyiv"):
        self.region_id = region_id
        self.dso_id = dso_id
        self.group_id = group_id
        self.tz = ZoneInfo(tz_name)
        self.base_url = (
            f"https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/"
            f"{self.region_id}/dsos/{self.dso_id}/planned-outages"
        )
        self._session = requests.Session()
        # Допуск раннього старту планового відключення
        self.early_start_grace_minutes = 45
        # Скільки часу після планового старту ще показувати повідомлення «мало відбутися»
        self.missed_start_grace_minutes = 90
        # Допустима затримка відновлення перед повідомленням «мало відновитися»
        self.restore_delay_grace_minutes = 90

    # ---------- HTTP ----------
    def fetch(self) -> Dict[str, Any]:
        r = self._session.get(self.base_url, timeout=15)
        r.raise_for_status()
        return r.json()

    # ---------- helpers ----------
    @staticmethod
    def _parse_slots(day: Dict[str, Any]) -> List[Slot]:
        return [Slot(s["start"], s["end"], s.get("type", "")) for s in day.get("slots", [])]

    def _extract_group(self, data: Dict[str, Any]) -> Dict[str, Any]:
        if self.group_id not in data:
            raise KeyError(f"Групу '{self.group_id}' не знайдено в відповіді API.")
        return data[self.group_id]

    def _day_outages(self, day_block: Dict[str, Any]) -> Dict[str, Any]:
        """
        Інтервали відключень є лише за 'ScheduleApplies'.
        'NoOutages' лишає порожній список: графік є, відключень немає.
        Інші статуси теж дають порожній список, але статус зберігаємо для тексту користувачу.
        """
        status = day_block.get("status", "")
        date_str = day_block.get("date")
        day_date = dt.datetime.fromisoformat(date_str).date() if date_str else dt.date.today()

        slots = self._parse_slots(day_block)
        outages = []

        if status == STATUS_SCHEDULE_APPLIES:
            for slot in slots:
                if slot.is_outage:
                    start_dt, end_dt = slot.as_time_range(day_date, self.tz)
                    outages.append({"start": start_dt, "end": end_dt, "type": slot.type})

        return {"date": day_date, "status": status, "outages": outages, "raw_slots": slots}

    # ---------- 1) Сьогодні ----------
    def get_today_outages(self, data_override: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = data_override if data_override else self.fetch()
        group = self._extract_group(data)
        return self._day_outages(group.get("today", {}))

    # ---------- 2) Завтра ----------
    def get_tomorrow_outages(self, data_override: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = data_override if data_override else self.fetch()
        group = self._extract_group(data)
        return self._day_outages(group.get("tomorrow", {}))

    # ---------- 3) Найближче включення ----------
    def get_nearest_restore_message(self, now: Optional[dt.datetime] = None,
                                    data_override: Optional[Dict[str, Any]] = None) -> str:
        """
        Інтервали беремо лише з 'ScheduleApplies'.
        'NoOutages' і порожній графік 'ScheduleApplies' — відключення поза графіком.
        """
        now = now.astimezone(self.tz) if now else dt.datetime.now(self.tz)
        data = data_override if data_override else self.fetch()
        group = self._extract_group(data)

        today_block = group.get("today", {})
        tomorrow_block = group.get("tomorrow", {})
        today_status = today_block.get("status") or ""
        tomorrow_status = tomorrow_block.get("status") or ""

        if today_status == STATUS_EMERGENCY_SHUTDOWNS:
            return f"🚨 Діють екстрені відключення. {schedule_link('Графік')} не діє."

        # Сьогодні графік є, але відключень у ньому немає — поточне зникнення світла позапланове.
        if today_status == STATUS_NO_OUTAGES:
            return _off_schedule_message()

        slots: List[tuple[dt.datetime, dt.datetime]] = []
        past_outages: List[tuple[dt.datetime, dt.datetime]] = []

        # Сьогодні
        if today_status == STATUS_SCHEDULE_APPLIES:
            today_date = dt.datetime.fromisoformat(today_block.get("date")).date() if today_block.get("date") else now.date()
            for slot in self._parse_slots(today_block):
                if not slot.is_outage:
                    continue
                start_dt, end_dt = slot.as_time_range(today_date, self.tz)
                if end_dt <= now:
                    past_outages.append((start_dt, end_dt))
                    continue
                if start_dt <= now <= end_dt or start_dt > now:
                    slots.append((start_dt, end_dt))

        # Завтра
        if tomorrow_status == STATUS_SCHEDULE_APPLIES:
            tomorrow_date = dt.datetime.fromisoformat(tomorrow_block.get("date")).date() if tomorrow_block.get("date") else (now.date() + dt.timedelta(days=1))
            for slot in self._parse_slots(tomorrow_block):
                if not slot.is_outage:
                    continue
                start_dt, end_dt = slot.as_time_range(tomorrow_date, self.tz)
                if end_dt <= now:
                    past_outages.append((start_dt, end_dt))
                elif end_dt > now:
                    slots.append((start_dt, end_dt))

        slots.sort(key=lambda t: t[0])

        if not slots and not past_outages:
            if today_status == STATUS_SCHEDULE_APPLIES:
                return _off_schedule_message()
            return _missing_schedule_message(today_status, tomorrow_status)

        # Якщо зараз в межах будь-якого запланованого інтервалу з допуском раннього старту — повертаємо час його завершення
        grace = dt.timedelta(minutes=self.early_start_grace_minutes)
        ongoing_indices = [idx for idx, (s, e) in enumerate(slots) if (s - grace) <= now <= e]
        if ongoing_indices:
            first_idx = min(ongoing_indices, key=lambda idx: slots[idx][0])
            extended_end = slots[first_idx][1]
            next_idx = first_idx + 1
            while next_idx < len(slots) and slots[next_idx][0] <= extended_end:
                extended_end = max(extended_end, slots[next_idx][1])
                next_idx += 1
            return f"За {schedule_link('графіком')} світло має відновитися о {extended_end.strftime('%H:%M')}."

        # Якщо є майбутній інтервал, який скоро почнеться — показуємо коли він закінчиться
        # (пріоритет майбутнього над "мало відновитися")
        future_slots = [(s, e) for s, e in slots if s > now]
        if future_slots:
            future_slots.sort(key=lambda t: t[0])
            nearest_future_start, nearest_future_end = future_slots[0]
            time_until_start = nearest_future_start - now
            # Якщо наступне відключення почнеться в межах grace period — показуємо його кінець
            if time_until_start <= dt.timedelta(minutes=self.restore_delay_grace_minutes):
                return f"За {schedule_link('графіком')} світло має відновитися о {nearest_future_end.strftime('%H:%M')}."

        if past_outages:
            latest_end = max(past_outages, key=lambda t: t[1])[1]
            delay = now - latest_end
            restore_grace = dt.timedelta(minutes=self.restore_delay_grace_minutes)
            if delay <= restore_grace:
                return f"За {schedule_link('графіком')} світло мало відновитися о {latest_end.strftime('%H:%M')}."

        # Інакше ми не в запланованому відключенні — це поза графіком/можливо аварійні
        return _off_schedule_message()

    # ---------- 4) Найближче відключення ----------
    def get_nearest_outage(self, now: Optional[dt.datetime] = None,
                           data_override: Optional[Dict[str, Any]] = None) -> Optional[dt.datetime]:
        """
        Повертає datetime початку найближчого відключення, або None.
        Враховує лише дні, де status == 'ScheduleApplies'.
        """
        now = now.astimezone(self.tz) if now else dt.datetime.now(self.tz)
        data = data_override if data_override else self.fetch()
        group = self._extract_group(data)

        today_block = group.get("today", {})
        tomorrow_block = group.get("tomorrow", {})

        candidates: List[dt.datetime] = []

        # Сьогодні
        if today_block.get("status") == STATUS_SCHEDULE_APPLIES:
            today_date = dt.datetime.fromisoformat(today_block.get("date")).date() if today_block.get("date") else now.date()
            for slot in self._parse_slots(today_block):
                if not slot.is_outage:
                    continue
                start_dt, end_dt = slot.as_time_range(today_date, self.tz)
                if end_dt <= now:
                    continue
                if start_dt > now:
                    candidates.append(start_dt)
                elif start_dt <= now <= end_dt:
                    return start_dt  # вже триває — це найближчий старт

        # Завтра
        if tomorrow_block.get("status") == STATUS_SCHEDULE_APPLIES:
            tomorrow_date = dt.datetime.fromisoformat(tomorrow_block.get("date")).date() if tomorrow_block.get("date") else (now.date() + dt.timedelta(days=1))
            for slot in self._parse_slots(tomorrow_block):
                if not slot.is_outage:
                    continue
                start_dt, _ = slot.as_time_range(tomorrow_date, self.tz)
                if start_dt > now:
                    candidates.append(start_dt)

        return min(candidates) if candidates else None

    def get_nearest_outage_message(self, now: Optional[dt.datetime] = None,
                                   data_override: Optional[Dict[str, Any]] = None) -> str:
        """
        Повертає підготовлене повідомлення про найближче відключення.
        Розрізняє: немає відключень в <a href="https://svitlo4u.online">графіку</a> vs розклад недоступний.
        """
        now = now.astimezone(self.tz) if now else dt.datetime.now(self.tz)
        data = data_override if data_override else self.fetch()
        group = self._extract_group(data)
        
        today_block = group.get("today", {})
        tomorrow_block = group.get("tomorrow", {})
        
        # Перевіряємо доступність розкладу
        today_status = today_block.get("status", "")
        tomorrow_status = tomorrow_block.get("status", "")

        if today_status == STATUS_EMERGENCY_SHUTDOWNS:
            return f"🚨 Діють екстрені відключення. {schedule_link('Графік')} не діє."

        # Сьогодні без опублікованого графіка, і завтра немає слотів — графіка немає.
        # NoOutages тут опублікований день: далі вийдемо в «відключень не передбачено»,
        # якщо завтра теж немає інтервалів.
        if today_status not in PUBLISHED_SCHEDULE_STATUSES and tomorrow_status != STATUS_SCHEDULE_APPLIES:
            return _missing_schedule_message(today_status, tomorrow_status)
        
        def _future_starts(day_block: Dict[str, Any], fallback_date: dt.date) -> List[dt.datetime]:
            if day_block.get("status") != STATUS_SCHEDULE_APPLIES:
                return []
            date_val = dt.datetime.fromisoformat(day_block.get("date")).date() if day_block.get("date") else fallback_date
            starts: List[dt.datetime] = []
            for slot in self._parse_slots(day_block):
                if not slot.is_outage:
                    continue
                start_dt, _ = slot.as_time_range(date_val, self.tz)
                if start_dt > now:
                    starts.append(start_dt.astimezone(self.tz))
            return starts

        def _past_starts(day_block: Dict[str, Any], fallback_date: dt.date) -> List[dt.datetime]:
            """Збирає минулі старти відключень для перевірки 'мало відбутися'."""
            if day_block.get("status") != STATUS_SCHEDULE_APPLIES:
                return []
            date_val = dt.datetime.fromisoformat(day_block.get("date")).date() if day_block.get("date") else fallback_date
            starts: List[dt.datetime] = []
            for slot in self._parse_slots(day_block):
                if not slot.is_outage:
                    continue
                start_dt, end_dt = slot.as_time_range(date_val, self.tz)
                # Минулий старт: start вже пройшов, але end ще в grace period
                if start_dt <= now:
                    starts.append(start_dt.astimezone(self.tz))
            return starts

        future_outages = sorted(
            _future_starts(today_block, now.date()) +
            _future_starts(tomorrow_block, now.date() + dt.timedelta(days=1))
        )

        # Пріоритет: спочатку показуємо майбутні відключення
        if future_outages:
            next_outage = future_outages[0]
            time_str = next_outage.strftime('%H:%M')
            if next_outage.date() == (now.date() + dt.timedelta(days=1)):
                return f"Найближче відключення завтра о {time_str}"
            return f"Найближче відключення о {time_str}"

        # Якщо майбутніх немає — перевіряємо минулі "мало відбутися"
        past_starts = sorted(
            _past_starts(today_block, now.date()) +
            _past_starts(tomorrow_block, now.date() + dt.timedelta(days=1)),
            reverse=True  # найновіший перший
        )
        if past_starts:
            latest_start = past_starts[0]
            elapsed = now - latest_start
            if elapsed <= dt.timedelta(minutes=self.missed_start_grace_minutes):
                return f"Відключення мало відбутися о {latest_start.strftime('%H:%M')}, очікуйте"

        return "💡 Сьогодні відключень не передбачено"