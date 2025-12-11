'use client';

import { useEffect, useState } from "react";

type SnakeTimelineSlot = {
  index: number;
  startHour: number;
  endHour: number;
  fillRatio: number;
  fillStartRatio: number;
};

type SnakeTimelineSummary = {
  plannedHours: number;
  actualHours: number;
  outageHours: number;
  lightHours: number;
  diffHours: number;
  hasActualData: boolean;
};

export type SnakeTimelineData = {
  slots: SnakeTimelineSlot[];
  dayLabel: string;
  dateLabel: string;
  nowHour: number;
  status: string | null;
  hasPlanSegments: boolean;
  isPlaceholder: boolean;
  currentTimeLabel: string;
  summary: SnakeTimelineSummary;
  contextLabel?: string;
  showCurrentTimeIndicator?: boolean;
  isFutureDay: boolean;
};

type SnakeDayTimelineProps = {
  todayData: SnakeTimelineData;
  tomorrowData: SnakeTimelineData;
};

const TOTAL_DAY_HOURS = 24;
const DEFAULT_SLOTS_PER_ROW = 6;
const COMPACT_SLOTS_PER_ROW = 4;
const OUTAGE_GRADIENT = "linear-gradient(120deg, rgba(100, 116, 139, 0.9), rgba(148, 163, 184, 0.95))";
const OUTAGE_BORDER = "rgba(148, 163, 184, 0.85)";
const LIGHT_GLOW = "rgba(52, 211, 153, 0.45)";
const OUTAGE_GLOW = "rgba(148, 163, 184, 0.35)";

function useCompactTimelineLayout() {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 520px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => setIsCompact(event.matches);

    handleChange(mediaQuery);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return isCompact;
}

type TabValue = "today" | "tomorrow";

export function SnakeDayTimeline({ todayData, tomorrowData }: SnakeDayTimelineProps) {
  const [activeTab, setActiveTab] = useState<TabValue>("today");
  const data = activeTab === "today" ? todayData : tomorrowData;
  const isCompactLayout = useCompactTimelineLayout();
  const slotsPerRow = isCompactLayout ? COMPACT_SLOTS_PER_ROW : DEFAULT_SLOTS_PER_ROW;
  const rowsCount = Math.ceil(TOTAL_DAY_HOURS / slotsPerRow);
  const showCurrentTime = data.showCurrentTimeIndicator !== false;
  const contextLabel = data.contextLabel ?? "Сьогодні";
  const isEmergency = data.status === "EmergencyShutdowns";
  const showEmptyState = !data.hasPlanSegments && !isEmergency;
  const rows = Array.from({ length: rowsCount }, (_, rowIndex) => {
    const startSlot = rowIndex * slotsPerRow;
    const rowSlots = data.slots.slice(startSlot, startSlot + slotsPerRow);
    const rowStartHour = rowIndex * slotsPerRow;
    const rowEndHour = rowStartHour + slotsPerRow;
    const containsNow =
      showCurrentTime && Number.isFinite(data.nowHour) && data.nowHour >= rowStartHour && data.nowHour < rowEndHour;
    const nowPercent = containsNow ? ((data.nowHour - rowStartHour) / slotsPerRow) * 100 : null;

    return {
      rowIndex,
      rowSlots,
      nowPercent,
    };
  });

  const isPlannedOutageNow = Boolean(
    data.hasPlanSegments &&
      Number.isFinite(data.nowHour) &&
      data.slots.some((slot) => {
        if (slot.fillRatio <= 0) {
          return false;
        }
        const coverageStart = slot.startHour + slot.fillStartRatio;
        const coverageEnd = coverageStart + slot.fillRatio;
        return data.nowHour >= coverageStart && data.nowHour < coverageEnd;
      })
  );

  const toneClassName = data.hasPlanSegments
    ? isPlannedOutageNow
      ? "border-rose-400/30 from-rose-950/60 via-slate-950/60 to-black"
      : "border-emerald-400/30 from-emerald-950/40 via-slate-950/60 to-black"
    : "border-slate-800/40 from-slate-950/50 via-zinc-950/50 to-black";

  const limitedOutageHours = Math.max(0, Math.min(24, data.summary.outageHours));
  const lightHoursLabel = formatHoursWithUnits(Math.max(data.summary.lightHours, 0));
  const outageHoursLabel = formatHoursWithUnits(limitedOutageHours);
  const plannedLabel = formatHoursAsClock(Math.max(data.summary.plannedHours, 0));
  const actualLabel = formatHoursAsClock(Math.max(data.summary.actualHours, 0));
  const diffValue = Math.abs(data.summary.diffHours);
  const diffLabel = `${data.summary.diffHours >= 0 ? "+" : "-"}${formatHoursAsClock(diffValue)}`;
  const diffToneClass = data.summary.diffHours >= 0 ? "text-emerald-300" : "text-rose-300";
  const showActualSummary =
    !data.isFutureDay && data.summary.hasActualData && (limitedOutageHours > 0 || data.summary.lightHours > 0);
  const plannedOutageHours = Math.max(0, Math.min(24, data.summary.plannedHours));
  const plannedLightHoursLabel = formatHoursWithUnits(Math.max(0, 24 - plannedOutageHours));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900/80 shadow-lg backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setActiveTab("today")}
          className={`flex-1 px-4 py-2.5 text-sm font-semibold transition-all ${
            activeTab === "today"
              ? "bg-emerald-600/80 text-white shadow-inner"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          Сьогодні
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("tomorrow")}
          className={`flex-1 px-4 py-2.5 text-sm font-semibold transition-all ${
            activeTab === "tomorrow"
              ? "bg-emerald-600/80 text-white shadow-inner"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          Завтра
        </button>
      </div>

      <div
        data-testid="snake-day-timeline"
        className={`relative overflow-hidden rounded-2xl border bg-linear-to-br px-5 py-6 text-zinc-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)] ${toneClassName}`}
      >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.15),transparent_55%)]" />
      <div className="relative z-10 flex flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-400">{contextLabel}</p>
            <h3 className="text-2xl font-semibold">{data.dayLabel}</h3>
            <p className="text-sm text-zinc-300">{data.dateLabel}</p>
          </div>

          <div className="flex flex-col items-end gap-1 text-right">
            {showCurrentTime ? (
              <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-200">
                Зараз {data.currentTimeLabel}
              </span>
            ) : null}
          </div>
        </header>

        {showEmptyState ? (
          <div className="rounded-2xl border border-dashed border-amber-200/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {activeTab === "today" ? "На сьогодні" : "На завтра"} графік відключень порожній.
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-inner backdrop-blur-sm">
            <div className="flex flex-wrap items-center gap-3 text-sm text-white">
              {data.isFutureDay ? (
                <SummaryBadge label="Світло має бути" value={plannedLightHoursLabel} tone="positive" />
              ) : showActualSummary ? (
                <>
                  <SummaryBadge label="Світло було" value={lightHoursLabel} tone="positive" />
                  <SummaryBadge label="Світла не було" value={outageHoursLabel} tone="negative" />
                </>
              ) : (
                <span className="text-xs text-white/70">Фактичні відключення ще не підтверджені.</span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-white/70">
              <MonoStat label="План" value={plannedLabel} />
              <MonoStat label="Факт" value={actualLabel} />
              <MonoStat label="Різниця" value={diffLabel} valueClassName={diffToneClass} />
            </div>
          </div>
        )}

        <div id="today-chart-blocks" className={`scroll-mt-32 flex flex-col gap-1.5 ${isEmergency ? "opacity-30" : ""}`}>
          {rows.map((row) => (
            <SnakeRow key={row.rowIndex} slots={row.rowSlots} nowPercent={row.nowPercent} />
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-300">
          <div className="flex flex-wrap items-center gap-2">
            <LegendChip label="Планове відключення" color="rgba(148,163,184,0.9)" />
            <LegendChip label="Світло" color="rgba(34,197,94,0.95)" />
            <LegendChip label="Теперішній час" variant="line" color="rgba(52,211,153,0.7)" />
          </div>
        </div>
      </div>
      {isEmergency ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center rounded-2xl bg-black/75 px-6 text-center">
          <span className="text-xs uppercase tracking-[0.35em] text-white/60">⚠️</span>
          <p className="mt-3 text-lg font-semibold uppercase tracking-wide text-white">
            ДІЮТЬ ЕКСТРЕННІ ВІДКЛЮЧЕННЯ
          </p>
        </div>
      ) : null}
      </div>
    </div>
  );
}

function SnakeRow({ slots, nowPercent }: { slots: SnakeTimelineSlot[]; nowPercent: number | null }) {
  return (
    <div className="relative flex items-center gap-1 px-1 py-1">
      {slots.map((slot) => (
        <SnakeSlotCell key={slot.index} slot={slot} />
      ))}

      {nowPercent != null ? (
        <div
          className="pointer-events-none absolute top-[-6px] bottom-[-6px] flex w-px justify-center"
          style={{ left: `${nowPercent}%` }}
        >
          <span className="h-full w-px bg-emerald-400/80">
            <span className="block h-2 w-2 -translate-x-1/2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.65)]" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SnakeSlotCell({ slot }: { slot: SnakeTimelineSlot }) {
  const widthPercent = Math.min(Math.max(slot.fillRatio, 0), 1) * 100;
  const offsetPercent = Math.min(Math.max(slot.fillStartRatio, 0), 1) * 100;
  const hasOutage = slot.fillRatio > 0;
  const outageStartHour = slot.startHour + slot.fillStartRatio;
  const outageEndHour = outageStartHour + slot.fillRatio;
  const EPS = 0.001;
  const isEndingWithinSlot = hasOutage && slot.fillStartRatio < EPS && slot.fillRatio < 1;
  const labelHour = hasOutage ? (isEndingWithinSlot ? outageEndHour : outageStartHour) : slot.startHour;
  const label = formatHourLabel(labelHour);

  return (
    <div className="relative flex-1">
      <div className="relative h-14 rounded-2xl border border-white/10 bg-white/5 shadow-inner">
        {widthPercent > 0 ? (
          <>
            <div
              className="absolute inset-y-1 rounded-2xl border"
              style={{
                width: `${widthPercent}%`,
                left: `${offsetPercent}%`,
                background: OUTAGE_GRADIENT,
                borderColor: OUTAGE_BORDER,
                boxShadow: `0 0 22px ${OUTAGE_GLOW}`,
                transition: "width 200ms ease, left 200ms ease",
              }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 rounded-2xl blur-2xl"
              style={{
                width: `${widthPercent}%`,
                left: `${offsetPercent}%`,
                background: OUTAGE_GLOW,
              }}
            />
          </>
        ) : (
          <div
            className="pointer-events-none absolute inset-y-0 rounded-2xl blur-2xl"
            style={{
              width: "100%",
              left: 0,
              background: LIGHT_GLOW,
            }}
          />
        )}
        <span
          className={`pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-semibold uppercase tracking-wide ${
            hasOutage ? "text-white/60" : "text-white drop-shadow-[0_1px_12px_rgba(0,0,0,0.75)]"
          }`}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

function LegendChip({ label, color, variant = "solid" }: { label: string; color?: string; variant?: "solid" | "line" }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/80">
      {variant === "line" ? (
        <span
          className="h-0 w-6 border-t-2 border-dashed"
          style={{ borderColor: color ?? "rgba(148,163,184,0.7)" }}
        />
      ) : (
        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color ?? "rgba(148,163,184,0.7)" }} />
      )}
      {label}
    </span>
  );
}

function SummaryBadge({ label, value, tone }: { label: string; value: string; tone: "positive" | "negative" }) {
  const toneClass =
    tone === "positive"
      ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-50 shadow-[0_0_22px_rgba(16,185,129,0.35)]"
      : "border-white/15 bg-zinc-500/10 text-white/70 shadow-[0_0_16px_rgba(148,163,184,0.25)]";

  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${toneClass}`}>
      <span className="text-[10px] uppercase tracking-wide text-white/60">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </span>
  );
}

function MonoStat({
  label,
  value,
  className,
  valueClassName,
}: {
  label: string;
  value: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-md bg-black/30 px-2.5 py-1 text-[11px] font-semibold text-white/80 ${className ?? ""}`}
    >
      <span className="text-white/60">{label}:</span>
      <span className={`text-white ${valueClassName ?? ""}`}>{value}</span>
    </span>
  );
}

function formatHourLabel(hourFraction: number) {
  const totalMinutes = Math.round(hourFraction * 60);
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (totalMinutes % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatHoursAsClock(rawValue: number) {
  const safeValue = Number.isFinite(rawValue) ? rawValue : 0;
  const totalMinutes = Math.round(Math.abs(safeValue) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function formatHoursWithUnits(rawValue: number) {
  const safeValue = Number.isFinite(rawValue) ? rawValue : 0;
  const totalMinutes = Math.round(Math.abs(safeValue) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const hourLabel = `${hours} год.`;
  const minuteLabel = `${minutes} хв.`;
  return `${hourLabel} ${minuteLabel}`;
}

export type { SnakeTimelineSlot };

