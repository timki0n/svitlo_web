"use client";

import { useMemo } from "react";
import {
  ArcElement,
  Chart as ChartJS,
  Filler,
  Legend,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { Doughnut } from "react-chartjs-2";

ChartJS.register(ArcElement, Tooltip, Legend, Filler);

export type GaugeVisualState =
  | {
      variant: "outage" | "uptime";
      completedMinutes: number;
      remainingMinutes: number;
      totalMinutes: number;
      topLabel: string;
      primaryLabel: string;
      secondaryLabel?: string;
      footnote?: string;
      isApproximate?: boolean;
    }
  | {
      variant: "none";
      topLabel: string;
      primaryLabel: string;
      secondaryLabel?: string;
      footnote?: string;
    };

type PowerStatusGaugeProps = {
  emoji: string;
  tone: "ok" | "warning";
  data: GaugeVisualState;
};

const MIN_ARC_MINUTES = 0.1;

export function PowerStatusGauge({ emoji, tone, data }: PowerStatusGaugeProps) {
  const { chartData, chartOptions } = useMemo(() => {
    if (data.variant === "none") {
      const fallback: ChartData<"doughnut"> = {
        labels: ["Немає даних"],
        datasets: [
          {
            data: [1],
            backgroundColor: ["rgba(148, 163, 184, 0.35)"],
            borderWidth: 0,
            hoverOffset: 0,
            borderRadius: 10,
          },
        ],
      };

      const options: ChartOptions<"doughnut"> = {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "72%",
        plugins: {
          tooltip: { enabled: false },
          legend: { display: false },
        },
      };

      return { chartData: fallback, chartOptions: options };
    }

    const completed = Math.max(data.completedMinutes, 0);
    const remaining = Math.max(data.remainingMinutes, 0);
    const hasRemaining = remaining > MIN_ARC_MINUTES;

    const colorPalette =
      data.variant === "outage"
        ? ["rgba(249, 115, 22, 0.9)", "rgba(253, 224, 171, 0.8)"]
        : ["rgba(34, 197, 94, 0.9)", "rgba(187, 247, 208, 0.85)"];

    const datasets = [
      {
        data: hasRemaining
          ? [Math.max(completed, MIN_ARC_MINUTES), Math.max(remaining, MIN_ARC_MINUTES)]
          : [Math.max(completed, MIN_ARC_MINUTES)],
        backgroundColor: hasRemaining ? colorPalette : [colorPalette[0]],
        borderWidth: 0,
        hoverOffset: 0,
        hoverBackgroundColor: hasRemaining ? colorPalette : [colorPalette[0]],
        borderRadius: 5,
      },
    ];

    const options: ChartOptions<"doughnut"> = {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      events: [],
      plugins: {
        tooltip: {
          enabled: false,
        },
        legend: {
          display: false,
        },
      },
    };

    return {
      chartData: {
        labels: hasRemaining ? ["Пройшло", "Залишилось"] : ["Прогрес"],
        datasets,
      },
      chartOptions: options,
    };
  }, [data]);

  const captionClassName =
    tone === "warning"
      ? "text-amber-600 dark:text-amber-400"
      : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="relative h-44 w-44 sm:h-52 sm:w-52">
        <Doughnut data={chartData} options={chartOptions} />

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1">
          <span className="text-5xl sm:text-6xl" role="img" aria-hidden="true">
            {emoji}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 sm:text-xs">
            {data.topLabel}
          </span>
          <span
            className={`text-sm font-semibold text-zinc-900 dark:text-zinc-50 sm:text-base ${data.variant === "none" ? "text-zinc-600 dark:text-zinc-300" : captionClassName}`}
          >
            {data.primaryLabel}
          </span>
        </div>
      </div>

      {data.secondaryLabel ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 sm:text-sm">{data.secondaryLabel}</p>
      ) : null}
      {data.footnote ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">{data.footnote}</p>
      ) : null}
    </div>
  );
}

