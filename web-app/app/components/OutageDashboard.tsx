import { ScheduleChartSection } from "./ScheduleChartSection";
import { PowerStatusGauge, type GaugeVisualState } from "./PowerStatusGauge";
import Settings from "./Settings";
import type { WeekForChart } from "./scheduleTypes";
import { SnakeDayTimeline, type SnakeTimelineData } from "./SnakeDayTimeline";

export type PowerStatus = {
  tone: "ok" | "warning";
  icon: string;
  title: string;
  subtitle: string;
  sinceISO: string | null;
  currentISO: string;
};

type OutageDashboardProps = {
  weeks: WeekForChart[];
  status: PowerStatus;
};

export function OutageDashboard({ weeks, status }: OutageDashboardProps) {
  const toneClassName =
    status.tone === "warning"
      ? "border-amber-200 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-900/20"
      : "border-lime-200 bg-lime-50 dark:border-lime-700/60 dark:bg-lime-900/20";
  const shadowClassName =
    status.tone === "warning"
      ? "shadow-[0_0_45px_rgba(245,158,11,0.25)] dark:shadow-[0_0_45px_rgba(245,158,11,0.22)]"
      : "shadow-[0_0_45px_rgba(16,185,129,0.22)] dark:shadow-[0_0_45px_rgba(16,185,129,0.18)]";
  const glowRadial =
    status.tone === "warning"
      ? "radial-gradient(circle at 50% 50%, rgba(245, 158, 11, 0.5), transparent 70%)"
      : "radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.45), transparent 70%)";
  const glowRadialDark =
    status.tone === "warning"
      ? "radial-gradient(circle at 50% 50%, rgba(234, 179, 8, 0.35), transparent 75%)"
      : "radial-gradient(circle at 50% 50%, rgba(34, 197, 94, 0.33), transparent 75%)";

  const now = new Date(status.currentISO);
  const since = status.sinceISO ? new Date(status.sinceISO) : null;
  const durationLabel = since ? formatElapsedDuration(since, now) : null;
  const durationPrefix = status.tone === "ok" ? "Світло є вже" : "Відключення триває";
  const planSummary = resolvePlanSummary(weeks, now);
  const snakeTimeline = resolveSnakeTimeline(weeks, now);
  const gaugeData = resolveGaugeState(weeks, status, now);
  const shouldShowDurationLine = durationLabel && gaugeData.variant === "none";

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <div
        className={`relative overflow-hidden rounded-2xl border text-center transition ${toneClassName} ${shadowClassName}`}
      >
        <Settings />
        <div
          className="pointer-events-none absolute inset-[-20%] z-0 md:animate-pulse blur-3xl"
          style={{
            background: glowRadial,
            animationDuration: "4s",
          }}
        />
        <div
          className="pointer-events-none absolute inset-[-20%] z-0 hidden md:animate-pulse blur-3xl dark:block"
          style={{
            background: glowRadialDark,
            animationDuration: "4s",
          }}
        />

        <div className="relative z-10 flex flex-col items-center gap-6 p-10 md:flex-row md:items-center md:gap-10 md:text-left">
          <PowerStatusGauge emoji={status.icon} tone={status.tone} data={gaugeData} />

          <div className="flex w-full flex-col items-center gap-3 text-zinc-900 dark:text-zinc-50 md:items-start">
            <div className="flex flex-col items-center gap-1 md:items-start">
              <p className="text-3xl font-semibold">{status.title}</p>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">{status.subtitle}</p>
              {shouldShowDurationLine ? (
                <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {durationPrefix}: {durationLabel}
                </p>
              ) : null}
            </div>

            <PlanSummaryBlock summary={planSummary} now={now} />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <SnakeDayTimeline data={snakeTimeline} />
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <ScheduleChartSection weeks={weeks} isPowerOutNow={status.tone === "warning"} />
      </div>
    </section>
  );
}

type PlanSegment = {
  start: Date;
  end: Date;
  durationMinutes: number;
};

type PlanSummary =
  | {
      kind: "emergency";
    }
  | {
      kind: "normal";
      segments: PlanSegment[];
      current: PlanSegment | null;
      next: PlanSegment | null;
    };

function PlanSummaryBlock({ summary, now }: { summary: PlanSummary | null; now: Date }) {
  if (!summary) {
    return (
      <div className="flex w-full flex-col gap-2 rounded-xl border border-zinc-200 bg-white/70 p-5 text-left shadow-sm dark:border-zinc-700 dark:bg-zinc-900/40">
        <h3 className="text-left text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Планові відключення на сьогодні
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          На сьогодні планові відключення не заплановані.
        </p>
      </div>
    );
  }

  if (summary.kind === "emergency") {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-zinc-200 bg-white/70 p-5 text-left shadow-sm dark:border-zinc-700 dark:bg-zinc-900/40">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Планові відключення на сьогодні
        </h3>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">⚠️ Графік не діє. Діють екстрені відключення.</p>
      </div>
    );
  }

  const { segments, current, next } = summary;
  const futureSegments = segments.filter((segment) => segment.end.getTime() > now.getTime());

  const headline = (() => {
    if (current) {
      return `Зараз триває планове відключення до ${formatTime(current.end)} (${formatDuration(
        current.durationMinutes
      )}).`;
    }

    if (next) {
      return `Наступне відключення розпочнеться о ${formatTime(next.start)} та триватиме ${formatDuration(
        next.durationMinutes
      )}.`;
    }

    return "На решту дня планові відключення не очікуються.";
  })();

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-zinc-200 bg-white/70 p-5 text-left shadow-sm dark:border-zinc-700 dark:bg-zinc-900/40">
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Планові відключення на сьогодні
      </h3>
      <p className="text-sm text-zinc-700 dark:text-zinc-200">{headline}</p>
      {futureSegments.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm text-zinc-600 dark:text-zinc-300">
          {futureSegments.map((segment) => {
            const isCurrent = current && segment.start.getTime() === current.start.getTime();
            const statusLabel = isCurrent ? "Триває" : "Заплановано";

            return (
              <li
                key={`${segment.start.toISOString()}-${segment.end.toISOString()}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200/70 bg-white/60 px-3 py-2 text-left dark:border-zinc-700/60 dark:bg-zinc-900/40"
              >
                <div className="flex flex-col">
                  <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {statusLabel}
                  </span>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">
                    {formatTimeRange(segment.start, segment.end)}
                  </span>
                </div>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatDuration(segment.durationMinutes)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function resolvePlanSummary(weeks: WeekForChart[], targetDate: Date): PlanSummary | null {
  const dayByKey = new Map(weeks.flatMap((week) => week.days).map((day) => [day.key, day]));
  const currentDay = dayByKey.get(formatDateKey(targetDate));
  const nextDay = dayByKey.get(formatDateKey(addDays(targetDate, 1)));

  if (currentDay?.status === "EmergencyShutdowns") {
    return { kind: "emergency" };
  }

  if ((!currentDay || currentDay.isPlaceholder) && (!nextDay || nextDay.isPlaceholder)) {
    return null;
  }

  const baseDate = currentDay ? parseDayDate(currentDay) : resetToStartOfDay(targetDate);

  if (!baseDate) {
    return null;
  }

  const segments: PlanSegment[] = [];

  if (currentDay && !currentDay.isPlaceholder) {
    currentDay.segments
      .filter((segment) => segment.source === "plan")
      .forEach((segment) => {
        const start = createDateForHour(baseDate, segment.startHour);
        const end = createDateForHour(baseDate, segment.endHour);

        if (!start || !end) {
          return;
        }

        if (end <= start) {
          const extendedEnd = new Date(end);
          extendedEnd.setDate(extendedEnd.getDate() + 1);
          segments.push({ start, end: extendedEnd, durationMinutes: calculateDuration(start, extendedEnd) });
          return;
        }

        segments.push({ start, end, durationMinutes: calculateDuration(start, end) });
      });
  }

  if (nextDay && !nextDay.isPlaceholder) {
    const nextBase = parseDayDate(nextDay);
    if (nextBase) {
      nextDay.segments
        .filter((segment) => segment.source === "plan")
        .filter((segment) => segment.startHour < 6)
        .forEach((segment) => {
          const start = createDateForHour(nextBase, segment.startHour);
          const end = createDateForHour(nextBase, segment.endHour);

          if (!start || !end || end.getTime() <= start.getTime()) {
            return;
          }

          segments.push({ start, end, durationMinutes: calculateDuration(start, end) });
        });
    }
  }

  const normalised = mergeContinuousSegments(segments)
    .map((segment) => ({
      ...segment,
      durationMinutes: calculateDuration(segment.start, segment.end),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (normalised.length === 0) {
    return null;
  }

  const nowTime = targetDate.getTime();
  const current = normalised.find(
    (segment) => segment.start.getTime() <= nowTime && nowTime < segment.end.getTime()
  ) ?? null;
  const next = normalised.find((segment) => segment.start.getTime() > nowTime) ?? null;

  return {
    kind: "normal",
    segments: normalised,
    current,
    next,
  };
}

function mergeContinuousSegments(segments: PlanSegment[]): PlanSegment[] {
  const sorted = segments
    .slice()
    .filter((segment) => segment.end.getTime() > segment.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (sorted.length === 0) {
    return [];
  }

  const result: PlanSegment[] = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const last = result[result.length - 1];
    const current = sorted[index];

    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
      continue;
    }

    result.push({ ...current });
  }

  return result;
}

function calculateDuration(start: Date, end: Date) {
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / (60 * 1000)));
}

function parseDayDate(day: WeekForChart["days"][number]): Date | null {
  if (day.dateISO) {
    const parsed = new Date(day.dateISO);

    if (!Number.isNaN(parsed.getTime())) {
      return resetToStartOfDay(parsed);
    }
  }

  const fallback = new Date(`${day.key}T00:00:00`);

  if (!Number.isNaN(fallback.getTime())) {
    return fallback;
  }

  return null;
}

function createDateForHour(base: Date, hourFraction: number): Date | null {
  if (!Number.isFinite(hourFraction)) {
    return null;
  }

  const result = new Date(base);
  const totalMinutes = Math.round(hourFraction * 60);
  result.setHours(0, 0, 0, 0);
  result.setMinutes(totalMinutes);

  return result;
}

function resetToStartOfDay(date: Date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimeRange(start: Date, end: Date) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function formatDuration(totalMinutes: number) {
  const rounded = Math.max(Math.round(totalMinutes), 0);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} год`);
  }

  if (minutes > 0) {
    parts.push(`${minutes} хв`);
  }

  return parts.length > 0 ? parts.join(" ") : "менше 1 хв";
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(date.getDate() + days);
  return result;
}

function formatElapsedDuration(from: Date, to: Date) {
  const diffMs = Math.max(to.getTime() - from.getTime(), 0);
  const totalMinutes = Math.floor(diffMs / (60 * 1000));
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

function resolveGaugeState(weeks: WeekForChart[], status: PowerStatus, now: Date): GaugeVisualState {
  const planSegments = collectPlanSegments(weeks);
  const nowTime = now.getTime();
  const activePlan = planSegments.find((segment) => segment.start.getTime() <= nowTime && nowTime < segment.end.getTime());
  let nextPlan = planSegments.find((segment) => segment.start.getTime() > nowTime);
  const previousPlan = [...planSegments].reverse().find((segment) => segment.end.getTime() <= nowTime);
  const allDays = weeks.flatMap((week) => week.days);
  const todayDay = allDays.find((day) => day.key === formatDateKey(now));
  const todayStatus = todayDay?.status ?? null;

  if (todayStatus === "EmergencyShutdowns") {
    return {
      variant: "none",
      topLabel: "ГРАФІК НЕ ДІЄ",
      primaryLabel: "⚠️⚠️⚠️",
      secondaryLabel: "Діють екстрені відключення.",
      footnote: "Слідкуйте за оновленнями.",
    };
  }

  if (status.tone === "warning") {
    const since = status.sinceISO ? new Date(status.sinceISO) : null;
    const start = since ?? activePlan?.start ?? now;
    const elapsedMinutes = diffMinutes(start, now);

    if (activePlan) {
      const remainingMinutes = diffMinutes(now, activePlan.end);
      const totalMinutes = Math.max(diffMinutes(start, activePlan.end), elapsedMinutes);
      const primaryLabel =
        remainingMinutes > 0 ? `~${formatDuration(remainingMinutes)}` : "ще трішки";

      return {
        variant: "outage",
        topLabel: "До відновлення",
        primaryLabel,
        secondaryLabel: undefined,
        footnote: ``,
        completedMinutes: elapsedMinutes,
        remainingMinutes,
        totalMinutes: Math.max(totalMinutes, 1),
        isApproximate: true,
      };
    }

    const baseTotal = Math.max(elapsedMinutes, 1);
    return {
      variant: "outage",
      topLabel: "До відновлення",
      primaryLabel: "Поки невідомо",
      secondaryLabel: undefined,
      footnote: "",
      completedMinutes: elapsedMinutes,
      remainingMinutes: 0,
      totalMinutes: baseTotal,
      isApproximate: false,
    };
  }

  if (activePlan) {
    const totalMinutes = Math.max(diffMinutes(activePlan.start, activePlan.end), 1);
    const elapsedMinutes = Math.min(diffMinutes(activePlan.start, now), totalMinutes);
    const isEarlyWindow = elapsedMinutes < totalMinutes / 2;

    if (isEarlyWindow) {
      return {
        variant: "none",
        topLabel: "До відключення",
        primaryLabel: "невідомо",
        secondaryLabel: `Планове вікно ${formatTimeRange(activePlan.start, activePlan.end)} ще триває.`,
        footnote: "Може зникнути будь-якої миті.",
      };
    }

    const afterCurrent = planSegments.find(
      (segment) => segment.start.getTime() >= activePlan.end.getTime()
    );
    nextPlan = afterCurrent ?? nextPlan;
  }

  if (!nextPlan) {
    return {
      variant: "none",
      topLabel: "До відключення",
      primaryLabel: "невідомо",
      secondaryLabel: previousPlan ? `Останній графік завершився ${formatShortDateTime(previousPlan.end, now)}` : undefined,
      footnote: "Графік на майбутні дні відсутній",
    };
  }

  const since = status.sinceISO ? new Date(status.sinceISO) : null;
  const uptimeStartCandidates = [since, previousPlan?.end].filter((value): value is Date => value != null);
  const uptimeStart =
    uptimeStartCandidates.find((date) => date.getTime() <= nowTime) ?? (remainingDuration(nextPlan, now) > 0 ? now : null);

  const totalMinutes = (() => {
    if (!uptimeStart) {
      return Math.max(diffMinutes(now, nextPlan.start), 1);
    }
    const computed = diffMinutes(uptimeStart, nextPlan.start);
    return computed > 0 ? computed : Math.max(diffMinutes(now, nextPlan.start), 1);
  })();

  const remainingMinutes = Math.max(diffMinutes(now, nextPlan.start), 0);
  const completedMinutes = Math.max(totalMinutes - remainingMinutes, 0);

  return {
    variant: "uptime",
    topLabel: "До відключення",
    primaryLabel:
      remainingMinutes > 0 ? `~${formatDuration(remainingMinutes)}` : "ще трохи",
    secondaryLabel:
      completedMinutes > 0 ? `Світло є вже ${formatDuration(completedMinutes)}` : undefined,
    footnote: ``,
    completedMinutes,
    remainingMinutes,
    totalMinutes,
    isApproximate: true,
  };
}

type NormalisedPlanSegment = {
  start: Date;
  end: Date;
};

function collectPlanSegments(weeks: WeekForChart[]): NormalisedPlanSegment[] {
  const segments: NormalisedPlanSegment[] = [];

  weeks.forEach((week) => {
    week.days.forEach((day) => {
      if (day.isPlaceholder) {
        return;
      }

      const baseDate = parseDayDate(day);

      if (!baseDate) {
        return;
      }

      day.segments
        .filter((segment) => segment.source === "plan")
        .forEach((segment) => {
          const start = createDateForHour(baseDate, segment.startHour);

          if (!start) {
            return;
          }

          const durationMinutes = Math.max(Math.round(segment.durationHours * 60), 1);
          const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

          segments.push({ start, end });
        });
    });
  });

  const sorted = segments
    .filter((segment) => segment.end.getTime() > segment.start.getTime())
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  return mergeAcrossDays(sorted);
}

function diffMinutes(from: Date, to: Date) {
  return Math.max((to.getTime() - from.getTime()) / (60 * 1000), 0);
}

function formatShortDateTime(target: Date, reference: Date) {
  if (isSameDay(target, reference)) {
    return formatTime(target);
  }

  const dateLabel = new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
  }).format(target);

  return `${dateLabel} о ${formatTime(target)}`;
}

function remainingDuration(segment: NormalisedPlanSegment, now: Date) {
  return Math.max(segment.end.getTime() - now.getTime(), 0);
}

function isSameDay(first: Date, second: Date) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function mergeAcrossDays(segments: NormalisedPlanSegment[]): NormalisedPlanSegment[] {
  if (segments.length === 0) {
    return [];
  }

  const merged: NormalisedPlanSegment[] = [{ start: new Date(segments[0].start), end: new Date(segments[0].end) }];

  for (let index = 1; index < segments.length; index += 1) {
    const last = merged[merged.length - 1];
    const current = segments[index];

    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = new Date(current.end);
      }
      continue;
    }

    const gapMinutes = (current.start.getTime() - last.end.getTime()) / (60 * 1000);

    if (gapMinutes <= 1) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = new Date(current.end);
      }
      continue;
    }

    merged.push({ start: new Date(current.start), end: new Date(current.end) });
  }

  return merged;
}

type SnakePlanSegment = {
  startHour: number;
  endHour: number;
};

function resolveSnakeTimeline(weeks: WeekForChart[], now: Date): SnakeTimelineData {
  const nowHour = getHourFraction(now);
  const dayByKey = new Map(weeks.flatMap((week) => week.days).map((day) => [day.key, day]));
  const todayKey = formatDateKey(now);
  const currentDay = dayByKey.get(todayKey) ?? null;
  const planSegments = currentDay ? normalisePlanSegments(currentDay.segments) : [];
  const slots = buildSnakeSlots(planSegments);
  const dayLabel = currentDay?.title ?? formatReadableDayLabel(now);
  const dateLabel = formatCalendarDate(currentDay?.dateISO ?? now.toISOString());
  const status = currentDay?.status ?? null;
  const hasPlanSegments = planSegments.length > 0;
  const isPlaceholder = currentDay ? Boolean(currentDay.isPlaceholder) : true;
  const plannedHours = currentDay?.plannedHours ?? 0;
  const actualHours = currentDay?.actualHours ?? 0;
  const outageHours = clampDurationHours(actualHours);
  const lightHours = Math.max(0, 24 - outageHours);
  const diffHours = plannedHours - actualHours;
  const hasActualData = currentDay ? currentDay.segments.some((segment) => segment.source === "actual") : false;

  return {
    slots,
    dayLabel,
    dateLabel,
    nowHour,
    status,
    hasPlanSegments,
    isPlaceholder,
    currentTimeLabel: formatTime(now),
    summary: {
      plannedHours,
      actualHours,
      outageHours,
      lightHours,
      diffHours,
      hasActualData,
    },
  };
}

function normalisePlanSegments(segments: WeekForChart["days"][number]["segments"]): SnakePlanSegment[] {
  return segments
    .filter((segment) => segment.source === "plan")
    .map((segment) => {
      const startHour = clampHour(segment.startHour);
      let endHour = clampHour(segment.endHour);

      if (endHour <= startHour) {
        endHour = 24;
      }

      return { startHour, endHour };
    })
    .filter((segment) => segment.endHour > segment.startHour);
}

function buildSnakeSlots(planSegments: SnakePlanSegment[]) {
  const SLOT_DURATION = 1;
  const TOTAL_SLOTS = 24;

  return Array.from({ length: TOTAL_SLOTS }).map((_, index) => {
    const startHour = index * SLOT_DURATION;
    const endHour = startHour + SLOT_DURATION;

    const overlaps = planSegments
      .map((segment) => {
        const overlapStart = Math.max(segment.startHour, startHour);
        const overlapEnd = Math.min(segment.endHour, endHour);

        if (overlapEnd <= overlapStart) {
          return null;
        }

        return { start: overlapStart, end: overlapEnd };
      })
      .filter((value): value is { start: number; end: number } => value !== null);

    if (overlaps.length === 0) {
      return {
        index,
        startHour,
        endHour,
        fillRatio: 0,
        fillStartRatio: 0,
      };
    }

    const coverageStart = overlaps.reduce((min, range) => Math.min(min, range.start), overlaps[0].start);
    const coverageEnd = overlaps.reduce((max, range) => Math.max(max, range.end), overlaps[0].end);

    const rawStartRatio = (coverageStart - startHour) / SLOT_DURATION;
    const rawEndRatio = (coverageEnd - startHour) / SLOT_DURATION;
    const fillStartRatio = clampRatio(rawStartRatio);
    const fillEndRatio = clampRatio(rawEndRatio);
    const fillRatio = clampRatio(fillEndRatio - fillStartRatio);

    return {
      index,
      startHour,
      endHour,
      fillRatio,
      fillStartRatio,
    };
  });
}

function getHourFraction(date: Date) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

function formatReadableDayLabel(date: Date) {
  const weekday = new Intl.DateTimeFormat("uk-UA", {
    weekday: "long",
  })
    .format(date)
    .replace(".", "");
  const capitalisedWeekday = weekday ? `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}` : "";
  const dayMonth = new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
  }).format(date);

  return `${capitalisedWeekday} (${dayMonth})`;
}

function formatCalendarDate(isoString: string | null) {
  if (!isoString) {
    return "";
  }

  const parsed = new Date(isoString);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function clampHour(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 24) {
    return 24;
  }

  return value;
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function clampDurationHours(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 24) {
    return 24;
  }

  return value;
}


