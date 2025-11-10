"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Title,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type Plugin,
  type ChartType,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import type { DayForChart, OutageSegment } from "./scheduleTypes";

type CurrentTimeLineOptions = {
  hour?: number | null;
};

declare module "chart.js" {
  interface PluginOptionsByType<TType extends ChartType> {
    currentTimeLine?: CurrentTimeLineOptions;
  }
}

const currentTimeLinePlugin: Plugin<"bar"> = {
  id: "currentTimeLine",
  afterDatasetsDraw(chart) {
    const pluginOptions = (chart.options.plugins as {
      currentTimeLine?: CurrentTimeLineOptions;
    })?.currentTimeLine;

    if (!pluginOptions || pluginOptions.hour == null) {
      return;
    }

    const xScale = chart.scales.x;
    const { ctx, chartArea } = chart;
    const x = xScale.getPixelForValue(pluginOptions.hour);

    if (Number.isNaN(x) || x < chartArea.left || x > chartArea.right) {
      return;
    }

    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  },
};

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  currentTimeLinePlugin
);

type ScheduleChartProps = {
  days: DayForChart[];
  isPowerOutNow?: boolean;
};

const TYPE_COLORS: Record<string, string> = {
  Definite: "rgba(220, 150, 10, 0.7)", // напів прозорий оранжевий
  Possible: "#f97316",
  Maintenance: "#3b82f6",
  Actual: "rgba(240, 20, 10, 0.7)",
  Unknown: "#22c55e",
};

const TYPE_LABELS: Record<string, string> = {
  Definite: "Планове відключення",
  Possible: "Можливе відключення",
  Maintenance: "Планове обслуговування",
  Actual: "Фактичне відключення",
  Unknown: "Інший тип",
};

function pickColor(type: string) {
  return TYPE_COLORS[type] ?? TYPE_COLORS.Unknown;
}

function formatHourTick(value: number) {
  const hours = Math.floor(value);
  const minutes = Math.round((value - hours) * 60);

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function formatHoursAsClock(rawValue: number) {
  let totalMinutes = Math.round(Math.abs(rawValue) * 60);

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}:${minutes.toString().padStart(2, "0")}`;
}

function formatHoursWithUnits(rawValue: number) {
  let totalMinutes = Math.round(Math.abs(rawValue) * 60);
  let hours = Math.floor(totalMinutes / 60);
  let minutes = totalMinutes % 60;

  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }

  const hourLabel = `${hours} год.`;
  const minuteLabel = `${minutes} хв.`;

  return `${hourLabel} ${minuteLabel}`;
}

function createBaseOptions(isMobile: boolean): ChartOptions<"bar"> {
  const stepSize = isMobile ? 2 : 1;
  const maxTicksLimit = isMobile ? 7 : 13;

  return {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
        mode: "nearest",
        axis: "xy",
        intersect: true,
    },
    plugins: {
      legend: {
        display: false,
      },
      title: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label(context) {
            return ` ${context.dataset.label ?? ""}`;
          },
        },
      },
      currentTimeLine: {
        hour: null,
      } as CurrentTimeLineOptions,
    },
    scales: {
      x: {
        min: 0,
        max: 24,
        stacked: true,
        ticks: {
          stepSize,
          maxTicksLimit,
          callback(value) {
            const numeric = Number(value);

            if (isMobile && numeric % 2 !== 0) {
              return "";
            }

            return formatHourTick(numeric);
          },
        },
        grid: {
          color: "rgba(148, 163, 184, 0.25)",
        },
      },
      y: {
        stacked: true,
        grid: {
          display: false,
        },
        ticks: {
          display: false,
        },
      },
    },
  };
}

function createOptionsForDay(
  baseOptions: ChartOptions<"bar">,
  day: DayForChart
): ChartOptions<"bar"> {
  // Обчислюємо поточну годину на клієнті лише для сьогоднішнього дня
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const dayDate = (() => {
    if (day.dateISO) {
      const parsed = new Date(day.dateISO);
      if (!Number.isNaN(parsed.getTime())) {
        parsed.setHours(0, 0, 0, 0);
        return parsed;
      }
    }
    const fallback = new Date(day.key);
    if (!Number.isNaN(fallback.getTime())) {
      fallback.setHours(0, 0, 0, 0);
      return fallback;
    }
    return null;
  })();

  const isToday = dayDate ? dayDate.getTime() === todayStart.getTime() : false;
  const now = new Date();
  const clientHour = isToday ? now.getHours() + now.getMinutes() / 60 : null;

  return {
    ...baseOptions,
    plugins: {
      ...baseOptions.plugins,
      currentTimeLine: {
        hour: clientHour,
      },
    },
  };
}

export function ScheduleChart({ days, isPowerOutNow = false }: ScheduleChartProps) {
  const isMobile = useIsMobile();
  const chartOptions = useMemo(() => createBaseOptions(isMobile), [isMobile]);

  const legendTypes = useMemo(() => {
    const items = new Set<string>();

    days.forEach((day) => {
      day.segments.forEach((segment) => items.add(segment.type));
    });

    return Array.from(items);
  }, [days]);

  const orderedLegendTypes = useMemo(() => {
    const order = ["Definite", "Actual", "Possible", "Maintenance", "Unknown"];
    const dynamic = legendTypes.filter((type) => !order.includes(type));

    return [...order.filter((type) => legendTypes.includes(type)), ...dynamic];
  }, [legendTypes]);

  return (
    <div className="flex flex-col gap-3">
      {legendTypes.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-300">
          {orderedLegendTypes.map((type) => (
            <span key={type} className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="h-3 w-3 rounded-sm"
                style={{ backgroundColor: pickColor(type) }}
              />
              {TYPE_LABELS[type] ?? type}
            </span>
          ))}
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className="h-0 w-8 border-t-2 border-dashed border-emerald-600"
            />
            Поточний час ({formatHourTick(new Date().getHours() + new Date().getMinutes() / 60)})
          </span>
        </div>
      )}

      {days.map((day) => {
        const hasSegments = day.segments.length > 0;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const dayDate = (() => {
          if (day.dateISO) {
            const parsed = new Date(day.dateISO);
            if (!Number.isNaN(parsed.getTime())) {
              parsed.setHours(0, 0, 0, 0);
              return parsed;
            }
          }

          const fallback = new Date(day.key);
          if (!Number.isNaN(fallback.getTime())) {
            fallback.setHours(0, 0, 0, 0);
            return fallback;
          }

          return null;
        })();

        const isToday = dayDate ? dayDate.getTime() === todayStart.getTime() : false;

        const placeholderMessage = hasSegments
          ? null
          : dayDate && dayDate < todayStart
            ? "Дані не знайдено"
            : "⌛ Очікуємо оновлення";

        const limitedActualHours = Math.min(day.actualHours, 24);
        const hasActualSummary = limitedActualHours > 0;

        const stackOffsets = new Map<string, number>();
        const data: ChartData<"bar"> = {
          labels: [day.title],
          datasets: day.segments.map((segment) => {
            const stackKey = `${segment.source}-${day.key}`;
            const previousEnd = stackOffsets.get(stackKey) ?? 0;
            const relativeStart = Math.max(segment.startHour - previousEnd, 0);
            const relativeEnd = Math.max(segment.endHour - previousEnd, relativeStart);

            stackOffsets.set(stackKey, segment.endHour);

            return {
              label: segment.label,
              data: [[relativeStart, relativeEnd]],
              backgroundColor: pickColor(segment.type),
              stack: stackKey,
              borderRadius: 1,
              borderSkipped: false,
              borderColor: segment.source === "actual" ? "rgba(240, 20, 10, 0.7)" : "rgba(220, 150, 10, 0.7)",
              borderWidth: 0,
              barThickness: 16,
              order: segment.source === "actual" ? 1 : 0,
            };
          }),
        };

        const options = createOptionsForDay(chartOptions, day);
        const nowHourValue = day.nowHour ?? null;
        const hasActualOutageNow =
          isToday &&
          nowHourValue != null &&
          day.segments.some(
            (segment) =>
              segment.source === "actual" &&
              nowHourValue >= segment.startHour &&
              nowHourValue < segment.endHour
          );
        const isOutageNow = isToday && (hasActualOutageNow || isPowerOutNow);
        const cardClassName = `relative overflow-hidden rounded-lg border border-zinc-200 bg-white p-2 shadow-sm transition-shadow duration-500 dark:border-zinc-800 dark:bg-zinc-950 ${
          isToday
            ? isOutageNow
              ? "border-rose-300 bg-gradient-to-r from-rose-50 via-white to-rose-50 shadow-[0_0_35px_rgba(244,63,94,0.35)] dark:border-rose-500 dark:from-rose-900/25 dark:via-zinc-950 dark:to-rose-900/25 dark:shadow-[0_0_35px_rgba(244,63,94,0.28)]"
              : "border-emerald-300 bg-gradient-to-r from-emerald-50 via-white to-emerald-50 shadow-[0_0_35px_rgba(52,211,153,0.35)] dark:border-emerald-500 dark:from-emerald-900/30 dark:via-zinc-950 dark:to-emerald-900/30 dark:shadow-[0_0_35px_rgba(16,185,129,0.28)]"
            : ""
        }`;

        return (
          <article key={day.key} className={cardClassName}>
            {isToday && (
              <div
                className={`pointer-events-none absolute -inset-8 z-0 md:animate-pulse blur-3xl ${
                  isOutageNow ? "bg-rose-400/20" : "bg-emerald-400/15"
                }`}
              />
            )}
            <div className="relative z-10">
              <header className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    {day.title}
                  </h3>
                  {hasActualSummary && (
                    <div className="flex flex-wrap items-center gap-1 text-[11px] font-normal text-zinc-500 dark:text-zinc-400">
                      <span>
                        Світло було:{" "}
                        <span style={{ color: "rgba(22, 163, 74, 0.7)" }}>
                          {formatHoursWithUnits(Math.max(24 - limitedActualHours, 0))}
                        </span>
                      </span>
                      <span>
                        Світла не було:{" "}
                        <span style={{ color: "rgba(220, 38, 38, 0.7)" }}>
                          {formatHoursWithUnits(limitedActualHours)}
                        </span>
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>План: {formatHoursAsClock(day.plannedHours)}</span>
                  <span>Факт: {formatHoursAsClock(day.actualHours)}</span>
                  {(() => {
                    // Поточна дата та година (з плаваючою частиною для хвилин)
                    const now = new Date();
                    const nowHour = now.getHours() + now.getMinutes() / 60;

                    // Очікується, що day.key — це дата у форматі, який можна парсити як new Date(day.key)
                    const dayDate = new Date(day.key);
                    dayDate.setHours(0, 0, 0, 0);

                    // Сьогодні, початок дня
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    // Якщо день в минулому
                    let showDiff = false;
                    if (dayDate < today) {
                      showDiff = true;
                    } else if (dayDate.getTime() === today.getTime()) {
                      // Якщо це сьогодні: знаходжу найперший плановий інтервал (планові сегменти = source === "plan")
                      const firstPlanned = day.segments
                        .filter((seg) => seg.source === "plan")
                        .sort((a, b) => a.startHour - b.startHour)[0];
                      if (firstPlanned && nowHour >= firstPlanned.startHour) {
                        showDiff = true;
                      }
                    }

                    if (showDiff) {
                      const diff = day.plannedHours - day.actualHours;
                      const isPositive = diff >= 0;
                      return (
                        <span>
                          Різниця:{" "}
                          <span style={{ opacity: 0.8, color: isPositive ? "#16a34a" : "#dc2626" }}>
                            {isPositive ? "+" : "-"}
                            {formatHoursAsClock(Math.abs(diff))}
                          </span>
                        </span>
                      );
                    }
                    return null;
                  })()}
                </div>
              </header>
              <div className="relative h-20 w-full">
                <Bar options={options} data={data} />
                {placeholderMessage && (
                  <div className="pointer-events-none absolute inset-x-0 top-5 flex items-start justify-center text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {placeholderMessage}
                  </div>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const update = () => {
      setIsMobile(window.innerWidth <= breakpoint);
    };

    update();
    window.addEventListener("resize", update);

    return () => {
      window.removeEventListener("resize", update);
    };
  }, [breakpoint]);

  return isMobile;
}

export type { DayForChart, OutageSegment } from "./scheduleTypes";
