from __future__ import annotations
import datetime as dt
from dataclasses import dataclass
from typing import List, Dict, Any, Optional
import requests
from zoneinfo import ZoneInfo

SCHEDULE_URL = "https://svitlo4u.online"


def schedule_link(label: str) -> str:
    return f'<a href="{SCHEDULE_URL}">{label}</a>'


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
    Працюємо з плановими <a href="https://svitlo4u.online">графіками</a> ТІЛЬКИ коли day.status == 'ScheduleApplies'.
    Все інше (WaitingForSchedule, тощо) — ігноруємо як відсутній <a href="https://svitlo4u.online">графік</a>.
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
        self.missed_start_grace_minutes = 60
        # Допустима затримка відновлення перед повідомленням «мало відновитися»
        self.restore_delay_grace_minutes = 60

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
        Якщо статус не 'ScheduleApplies' — повертаємо порожній список відключень,
        але залишаємо статус як є (щоб можна було показати користувачу).
        """
        status = day_block.get("status", "")
        date_str = day_block.get("date")
        day_date = dt.datetime.fromisoformat(date_str).date() if date_str else dt.date.today()

        slots = self._parse_slots(day_block)
        outages = []

        if status == "ScheduleApplies":
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
        Беремо тільки дні з status == 'ScheduleApplies'.
        Якщо жодного релевантного відрізку не знайдено — "<a href="https://svitlo4u.online">Графік</a> не знайдено."
        """
        now = now.astimezone(self.tz) if now else dt.datetime.now(self.tz)
        data = data_override if data_override else self.fetch()
        group = self._extract_group(data)

        today_block = group.get("today", {})
        tomorrow_block = group.get("tomorrow", {})

        if today_block.get("status") == "EmergencyShutdowns":
            return f"🚨 Діють екстрені відключення. {schedule_link('Графік')} не діє."

        slots: List[tuple[dt.datetime, dt.datetime]] = []
        past_outages: List[tuple[dt.datetime, dt.datetime]] = []
        schedule_available = False

        # Сьогодні
        if today_block.get("status") == "ScheduleApplies":
            schedule_available = True
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
        if tomorrow_block.get("status") == "ScheduleApplies":
            schedule_available = True
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
            if not schedule_available:
                status_msgs = []
                today_status = today_block.get("status")
                tomorrow_status = tomorrow_block.get("status")
                if today_status and today_status != "ScheduleApplies":
                    status_msgs.append(f"сьогодні — {today_status}")
                if tomorrow_status and tomorrow_status != "ScheduleApplies":
                    status_msgs.append(f"завтра — {tomorrow_status}")
                if status_msgs:
                    return f"{schedule_link('Графік')} недоступний («" + "; ".join(status_msgs) + "»)."
                return f"{schedule_link('Графік')} недоступний."
            return f"{schedule_link('Графік')} не знайдено."

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

        if past_outages:
            latest_end = max(past_outages, key=lambda t: t[1])[1]
            delay = now - latest_end
            restore_grace = dt.timedelta(minutes=self.restore_delay_grace_minutes)
            if delay <= restore_grace:
                return f"За {schedule_link('графіком')} світло мало відновитися о {latest_end.strftime('%H:%M')}."

        # Інакше ми не в запланованому відключенні — це поза графіком/можливо аварійні
        return f"Відключення поза {schedule_link('графіком')}/можливо аварійні."

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
        if today_block.get("status") == "ScheduleApplies":
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
        if tomorrow_block.get("status") == "ScheduleApplies":
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

        if today_status == "EmergencyShutdowns":
            return f"🚨 Діють екстрені відключення. {schedule_link('Графік')} не діє."
        
        # Якщо обидва дні мають статус, не "ScheduleApplies" — розклад недоступний
        if today_status != "ScheduleApplies" and tomorrow_status != "ScheduleApplies":
            if today_status == "WaitingForSchedule" or tomorrow_status == "WaitingForSchedule":
                return f"⌛ {schedule_link('Графік')} ще не опубліковано"
            return f"⚠️ {schedule_link('Графік')} недоступний (статус: {today_status})"
        
        def _future_starts(day_block: Dict[str, Any], fallback_date: dt.date) -> List[dt.datetime]:
            if day_block.get("status") != "ScheduleApplies":
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

        future_outages = sorted(
            _future_starts(today_block, now.date()) +
            _future_starts(tomorrow_block, now.date() + dt.timedelta(days=1))
        )

        nearest_outage = self.get_nearest_outage(now=now, data_override=data_override)
        if nearest_outage is not None:
            nearest_outage = nearest_outage.astimezone(self.tz)
            if now >= nearest_outage:
                elapsed = now - nearest_outage
                if elapsed <= dt.timedelta(minutes=self.missed_start_grace_minutes):
                    return f"Відключення мало відбутися о {nearest_outage.strftime('%H:%M')}, очікуйте"

        if today_block.get("status") == "EmergencyShutdowns":
            return f"🚨 Діють екстрені відключення. {schedule_link('Графік')} не діє."

        if not future_outages:
            return "💡 Сьогодні відключень не передбачено"

        next_outage = future_outages[0]
        time_str = next_outage.strftime('%H:%M')
        if next_outage.date() == (now.date() + dt.timedelta(days=1)):
            return f"Найближче відключення завтра о {time_str}"
        return f"Найближче відключення о {time_str}"