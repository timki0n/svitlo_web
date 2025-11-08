import { OutageDashboard, type PowerStatus } from "@/app/components/OutageDashboard";
import type { DayForChart, WeekForChart } from "@/app/components/scheduleTypes";
import {
  getActualOutages,
  getSchedules,
  type ActualOutageRow,
  type ScheduleRow,
} from "@/lib/db";

export default function Home() {
  const schedules = getSchedules();
  const actualOutages = getActualOutages();
  const chartWeeks = prepareWeeksForChart(schedules, actualOutages);
  const currentStatus = resolveCurrentStatus(actualOutages);
  const backgroundImagePath =
    currentStatus.tone === "warning"
      ? "/backgrounds/4u_nolight.png"
      : "/backgrounds/4u_light.png";

  return (
    <main className="relative flex min-h-screen flex-col gap-10 bg-zinc-50/60 px-6 py-12 font-sans text-zinc-900 backdrop-blur-[1px] dark:bg-black/70 dark:text-zinc-50">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <img
          src={backgroundImagePath}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover object-center"
        />
        <div
          className="absolute inset-0"
        />
        <div className="absolute inset-0 bg-black/35 mix-blend-multiply" />
      </div>

      <OutageDashboard weeks={chartWeeks} status={currentStatus} />
    </main>
  );
}

function resolveCurrentStatus(actualRows: ActualOutageRow[]): PowerStatus {
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const rowsByLatest = [...actualRows].reverse();
  const activeOutage = rowsByLatest.find(
    (row) => row.start_ts <= nowSeconds && (row.end_ts == null || row.end_ts > nowSeconds)
  );

  if (activeOutage) {
    const startedAt = new Date(activeOutage.start_ts * 1000);
    const elapsedMinutes = Math.max(
      Math.floor((now.getTime() - startedAt.getTime()) / (60 * 1000)),
      0
    );
    const elapsedLabel = formatElapsedMinutes(elapsedMinutes);

    return {
      tone: "warning",
      icon: "⚠️",
      title: "Світла немає",
      subtitle: `Відключення триває ${elapsedLabel} (з ${formatStatusTimestamp(startedAt)}).`,
      sinceISO: startedAt.toISOString(),
      currentISO: now.toISOString(),
    };
  }

  const lastEndedOutage = rowsByLatest.find((row) => row.end_ts != null && row.end_ts <= nowSeconds);
  const sinceDate = lastEndedOutage ? new Date(lastEndedOutage.end_ts! * 1000) : null;

  const subtitle = sinceDate
    ? `Останнє відключення завершилось ${formatStatusTimestamp(sinceDate)}.`
    : "Фактичних відключень ще не зафіксовано.";

  return {
    tone: "ok",
    icon: "😊",
    title: "Світло є",
    subtitle,
    sinceISO: sinceDate ? sinceDate.toISOString() : null,
    currentISO: now.toISOString(),
  };
}

function formatStatusTimestamp(date: Date) {
  const dateFormatter = new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${dateFormatter.format(date)} ${timeFormatter.format(date)}`;
}

function formatElapsedMinutes(totalMinutes: number) {
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days} д`);
  }

  if (hours > 0) {
    parts.push(`${hours} год`);
  }

  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} хв`);
  }

  return parts.slice(0, 2).join(" ");
}

function prepareWeeksForChart(
  scheduleRows: ScheduleRow[],
  actualRows: ActualOutageRow[]
): WeekForChart[] {
  type GroupAccumulator = {
    dateLabel: string;
    date: Date | null;
    segments: DayForChart["segments"];
    plannedHours: number;
    actualHours: number;
  };

  const grouped = new Map<string, GroupAccumulator>();

  const now = new Date();
  const nowHour = clampHour(getHourFraction(now));

  const addSegment = (segment: ParsedOutage) => {
    if (segment.endHour <= segment.startHour) {
      return;
    }

    const entry: DayForChart["segments"][number] = {
      id: segment.id,
      source: segment.source,
      startHour: segment.startHour,
      endHour: segment.endHour,
      type: segment.type,
      label: segment.label,
      durationHours: segment.durationHours,
    };

    const plannedDelta = segment.source === "plan" ? segment.durationHours : 0;
    const actualDelta = segment.source === "actual" ? segment.durationHours : 0;

    const existing = grouped.get(segment.groupKey);

    if (!existing) {
      grouped.set(segment.groupKey, {
        dateLabel: segment.groupLabel,
        date: segment.groupDate,
        segments: [entry],
        plannedHours: plannedDelta,
        actualHours: actualDelta,
      });

      return;
    }

    existing.segments.push(entry);
    existing.plannedHours += plannedDelta;
    existing.actualHours += actualDelta;

    if (!existing.date && segment.groupDate) {
      existing.date = segment.groupDate;
    }
  };

  scheduleRows.forEach((row) => {
    parseScheduleOutages(row).forEach(addSegment);
  });

  parseActualOutages(actualRows).forEach(addSegment);

  const normalisedDays = Array.from(grouped.entries())
    .sort(([keyA, valueA], [keyB, valueB]) => {
      const timeA = valueA.date?.getTime();
      const timeB = valueB.date?.getTime();

      if (typeof timeA === "number" && typeof timeB === "number") {
        return timeA - timeB;
      }

      if (typeof timeA === "number") {
        return -1;
      }

      if (typeof timeB === "number") {
        return 1;
      }

      return keyA.localeCompare(keyB);
    })
    .map(([key, value]) => {
      const sortedSegments = value.segments.sort((left, right) => left.startHour - right.startHour);
      const dateISO = value.date ? value.date.toISOString() : parseScheduleDate(key)?.toISOString() ?? null;

      return {
        key,
        title: value.dateLabel,
        plannedHours: value.plannedHours,
        actualHours: value.actualHours,
        segments: sortedSegments,
        nowHour: value.date && isSameDay(value.date, now) ? nowHour : null,
        dateISO,
        isPlaceholder: sortedSegments.length === 0,
      };
    });

  const normalisedByKey = new Map(normalisedDays.map((day) => [day.key, day]));

  const allDates = normalisedDays
    .map((day) => {
      if (day.dateISO) {
        const parsed = new Date(day.dateISO);

        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }

      return parseScheduleDate(day.key);
    })
    .filter((value): value is Date => value != null);

  const baselineWeekStart = startOfWeek(now);
  let firstWeekStart = new Date(baselineWeekStart);
  let lastWeekStart = new Date(baselineWeekStart);

  if (allDates.length > 0) {
    const minDate = allDates.reduce((acc, date) => (date < acc ? date : acc), allDates[0]);
    const maxDate = allDates.reduce((acc, date) => (date > acc ? date : acc), allDates[0]);

    firstWeekStart = startOfWeek(minDate);
    lastWeekStart = startOfWeek(maxDate);

    if (firstWeekStart.getTime() > baselineWeekStart.getTime()) {
      firstWeekStart = new Date(baselineWeekStart);
    }

    if (lastWeekStart.getTime() < baselineWeekStart.getTime()) {
      lastWeekStart = new Date(baselineWeekStart);
    }
  }

  const weeks: WeekForChart[] = [];

  for (
    let cursor = new Date(firstWeekStart);
    cursor.getTime() <= lastWeekStart.getTime();
    cursor = addDays(cursor, 7)
  ) {
    const weekStart = new Date(cursor);
    const weekEnd = addDays(weekStart, 6);

    const daysForWeek: DayForChart[] = Array.from({ length: 7 }).map((_, index) => {
      const currentDate = addDays(weekStart, index);
      const key = formatDateKey(currentDate);
      const existing = normalisedByKey.get(key);
      const baseNowHour = isSameDay(currentDate, now) ? nowHour : null;
      const dateISO = currentDate.toISOString();

      if (existing) {
        return {
          ...existing,
          nowHour: baseNowHour,
          dateISO: existing.dateISO ?? dateISO,
          isPlaceholder: existing.segments.length === 0,
        };
      }

      return {
        key,
        title: formatGroupLabel(key),
        plannedHours: 0,
        actualHours: 0,
        segments: [],
        nowHour: baseNowHour,
        dateISO,
        isPlaceholder: true,
      };
    });

    weeks.push({
      id: formatDateKey(weekStart),
      startISO: weekStart.toISOString(),
      endISO: weekEnd.toISOString(),
      rangeLabel: formatWeekRange(weekStart, weekEnd),
      days: daysForWeek,
    });
  }

  return weeks;
}

type BaseParsedOutage = {
  id: string;
  groupKey: string;
  groupLabel: string;
  groupDate: Date | null;
  startHour: number;
  endHour: number;
  type: string;
  label: string;
  durationHours: number;
};

type ParsedOutage = BaseParsedOutage & {
  source: "plan" | "actual";
};

function parseScheduleOutages(row: ScheduleRow): ParsedOutage[] {
  try {
    const parsed = JSON.parse(row.outages_json);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item, index) => normaliseOutage(row.schedule_date, item, index))
      .filter((segment): segment is BaseParsedOutage => segment !== null)
      .map((segment) => ({
        ...segment,
        id: `${segment.id}-plan`,
        source: "plan",
      }));
  } catch (error) {
    console.warn("Не вдалося розпарсити outages_json:", error);

    return [];
  }
}

function parseActualOutages(rows: ActualOutageRow[]): ParsedOutage[] {
  const now = new Date();
  const segments: ParsedOutage[] = [];

  rows.forEach((row, rowIndex) => {
    const startDate = new Date(row.start_ts * 1000);
    const endDate = row.end_ts != null ? new Date(row.end_ts * 1000) : now;

    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      endDate.getTime() <= startDate.getTime()
    ) {
      return;
    }

    let cursorStart = startDate;
    let segmentIndex = 0;

    while (cursorStart < endDate) {
      const dayKey = formatDateKey(cursorStart);
      const nextDay = startOfNextDay(cursorStart);
      const segmentEndDate = new Date(Math.min(endDate.getTime(), nextDay.getTime()));

      const base = normaliseOutage(
        dayKey,
        {
          start: cursorStart.toISOString(),
          end: segmentEndDate.toISOString(),
          type: "Actual",
        },
        segmentIndex
      );

      if (base) {
        segments.push({
          ...base,
          id: `${base.id}-actual-${rowIndex}-${segmentIndex}`,
          source: "actual",
          label: `Факт: ${formatTime(cursorStart)} – ${formatTime(segmentEndDate)} (${base.durationHours.toFixed(
            2
          )} год)`,
        });
      }

      if (segmentEndDate.getTime() === nextDay.getTime() && segmentEndDate < endDate) {
        cursorStart = nextDay;
      } else {
        cursorStart = segmentEndDate;
      }

      segmentIndex += 1;
    }
  });

  return segments;
}

function normaliseOutage(
  scheduleDate: string,
  raw: unknown,
  index: number
): BaseParsedOutage | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("start" in raw) ||
    !("end" in raw)
  ) {
    return null;
  }

  const { start, end, type } = raw as {
    start: unknown;
    end: unknown;
    type?: unknown;
  };

  if (typeof start !== "string" || typeof end !== "string") {
    return null;
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return null;
  }

  const groupKey = scheduleDate;
  const groupLabel = formatGroupLabel(scheduleDate);
  const groupDate = parseScheduleDate(scheduleDate);
  const durationHours = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);

  if (durationHours <= 0) {
    return null;
  }

  const startHour = clampHour(getHourFraction(startDate));
  let endHour = clampHour(getHourFraction(endDate));

  if (endHour <= startHour) {
    endHour = 24;
  }

  const outageType = typeof type === "string" ? type : "Unknown";
  const label = `${formatTime(startDate)} – ${formatTime(endDate)} (${outageType}, ${durationHours.toFixed(
    2
  )} год)`;

  return {
    id: `${scheduleDate}-${index}`,
    groupKey,
    groupLabel,
    groupDate,
    startHour,
    endHour,
    type: outageType,
    label,
    durationHours,
  };
}

function getHourFraction(date: Date) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

function clampHour(value: number) {
  const min = 0;
  const max = 24;

  return Math.min(Math.max(value, min), max);
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function startOfNextDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function formatWeekRange(start: Date, end: Date) {
  const formatter = new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
  });

  const startLabel = formatter.format(start);
  const endLabel = formatter.format(end);

  return `${startLabel} – ${endLabel}`;
}

function formatGroupLabel(rawDate: string) {
  const parsed = new Date(rawDate);

  if (Number.isNaN(parsed.getTime())) {
    return rawDate;
  }

  const weekday = new Intl.DateTimeFormat("uk-UA", {
    weekday: "short",
  })
    .format(parsed)
    .replace(".", "");

  const capitalisedWeekday = weekday
    ? `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}`
    : rawDate;

  const dayMonth = new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
  }).format(parsed);

  return `${capitalisedWeekday} (${dayMonth})`;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseScheduleDate(rawDate: string): Date | null {
  const direct = new Date(rawDate);

  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const fallback = new Date(`${rawDate}T00:00:00`);

  if (!Number.isNaN(fallback.getTime())) {
    return fallback;
  }

  return null;
}

function isSameDay(first: Date, second: Date) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function startOfWeek(date: Date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);

  const day = clone.getDay();
  const diff = (day + 6) % 7;

  clone.setDate(clone.getDate() - diff);

  return clone;
}

function addDays(date: Date, amount: number) {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + amount);
  clone.setHours(0, 0, 0, 0);

  return clone;
}
