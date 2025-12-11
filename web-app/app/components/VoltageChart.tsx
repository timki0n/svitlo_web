"use client";

import { useMemo, useState } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
  type ActiveElement,
  type ChartData,
  type ChartEvent,
  type ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";
import type { VoltageStats } from "@/lib/homeassistant";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

type TimeRange = "24h" | "6h" | "3h" | "1h";

const RANGE_CONFIG: Record<
  TimeRange,
  {
    label: string;
    hours: number;
  }
> = {
  "24h": { label: "24 год", hours: 24 },
  "6h": { label: "6 год", hours: 6 },
  "3h": { label: "3 год", hours: 3 },
  "1h": { label: "1 год", hours: 1 },
};

type VoltageChartProps = {
  stats: VoltageStats | null;
};

export function VoltageChart({ stats }: VoltageChartProps) {
  const [range, setRange] = useState<TimeRange>("1h");

  const filtered = useMemo(() => {
    if (!stats) return [];

    const now = Date.now();
    const cutoffMs = now - RANGE_CONFIG[range].hours * 60 * 60 * 1000;

    return stats.entries
      .map((entry) => ({
        ts: new Date(entry.timestamp).getTime(),
        voltage: entry.voltage,
      }))
      .filter((item) => Number.isFinite(item.ts) && item.ts >= cutoffMs && item.voltage != null)
      .sort((a, b) => a.ts - b.ts);
  }, [stats, range]);

  const downsampled = useMemo(() => {
    const MAX_POINTS = 240;

    if (filtered.length <= MAX_POINTS) {
      return filtered;
    }

    const step = Math.ceil(filtered.length / MAX_POINTS);
    const result: { ts: number; voltage: number }[] = [];

    for (let i = 0; i < filtered.length; i += step) {
      const slice = filtered.slice(i, i + step);
      const avg =
        slice.reduce((sum, item) => sum + (item.voltage ?? 0), 0) /
        Math.max(slice.length, 1);
      const mid = slice[Math.floor(slice.length / 2)] ?? slice[0];
      if (mid) {
        result.push({ ts: mid.ts, voltage: avg });
      }
    }

    return result;
  }, [filtered]);

  // Вставляємо розриви (null) у випадку великих прогалин у даних
  const withGaps = useMemo(() => {
    const GAP_THRESHOLD_MS = 15 * 60 * 1000; // 15 хвилин — вважаємо паузою, малюємо розрив
    if (downsampled.length === 0) return [];

    const result: { ts: number; voltage: number | null }[] = [];

    for (let i = 0; i < downsampled.length; i++) {
      const current = downsampled[i];
      const next = downsampled[i + 1];

      result.push(current);

      if (next) {
        const gap = next.ts - current.ts;
        if (gap > GAP_THRESHOLD_MS) {
          // додаємо точку-розрив з null, щоб Chart.js не з'єднував лінії
          const gapTs = current.ts + Math.floor(gap / 2);
          result.push({ ts: gapTs, voltage: null });
        }
      }
    }

    return result;
  }, [downsampled]);

  const summary = useMemo(() => {
    if (filtered.length === 0) {
      return { avg: null, min: null, max: null, count: 0 };
    }

    const values = filtered.map((item) => item.voltage ?? 0);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      avg: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    };
  }, [filtered]);

  const chartData: ChartData<"line"> = useMemo(
    () => ({
      labels: withGaps.map((item) => formatTime(item.ts)),
      datasets: [
        {
          label: "Напруга, В",
          data: withGaps.map((item) => item.voltage),
          borderColor: "#22c55e",
          backgroundColor: "rgba(34, 197, 94, 0.15)",
          tension: 0.25,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderWidth: 2,
          spanGaps: false, // не з'єднувати через null
        },
      ],
    }),
    [withGaps]
  );

  const options: ChartOptions<"line"> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const value = ctx.parsed.y;
              const label = ctx.label ?? "";
              return `${label} — ${formatCompact(value)} В`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
          },
          grid: { color: "rgba(148, 163, 184, 0.15)" },
        },
        y: {
          beginAtZero: false,
          grid: { color: "rgba(148, 163, 184, 0.15)" },
          ticks: {
            callback(value) {
              return `${value} В`;
            },
          },
        },
      },
    }),
    []
  );

  const latestValue = useMemo(() => {
    const item = [...withGaps].reverse().find((entry) => entry.voltage != null);
    return item ?? null;
  }, [withGaps]);

  if (!stats) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white/70 p-4 text-sm text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
        Дані про напругу не знайдено.
      </div>
    );
  }

  const isEmpty = filtered.length === 0;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white/70 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Статистика напруги</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Останнє оновлення: {formatDateTime(stats.fetchedAt)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {[...(Object.keys(RANGE_CONFIG) as TimeRange[])].reverse().map((key) => {
            const active = range === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setRange(key)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  active
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400 dark:bg-emerald-400/10 dark:text-emerald-100"
                    : "border-zinc-200 bg-white/80 text-zinc-700 hover:border-emerald-200 hover:text-emerald-700 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:border-emerald-700/60"
                }`}
              >
                {RANGE_CONFIG[key].label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-zinc-700 dark:text-zinc-200">
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-100">
          <span className="font-semibold">
            {latestValue ? `Зараз: ${formatCompact(latestValue.voltage)} В` : "—"}
          </span>
        </span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Середня" value={summary.avg} suffix="В" tone="neutral" />
        <StatCard label="Мінімум" value={summary.min} suffix="В" tone="negative" />
        <StatCard label="Максимум" value={summary.max} suffix="В" tone="positive" />
      </div>

      <div className="relative h-64 md:h-80">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
            Немає даних за вибраний період.
          </div>
        ) : (
          <Line options={options} data={chartData} />
        )}
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  suffix,
  tone,
  isCount = false,
}: {
  label: string;
  value: number | null;
  suffix: string;
  tone: "neutral" | "positive" | "negative";
  isCount?: boolean;
}) {
  const color =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-300"
      : tone === "negative"
        ? "text-rose-600 dark:text-rose-300"
        : "text-zinc-800 dark:text-zinc-100";

  const formatted = isCount
    ? value ?? 0
    : formatCompact(value);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white/70 px-3 py-2 shadow-inner dark:border-zinc-800 dark:bg-zinc-900/70">
      <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`text-lg font-semibold ${color}`}>
        {formatted}
        {suffix ? ` ${suffix}` : ""}
      </p>
    </div>
  );
}

function formatTime(ts: number) {
  const date = new Date(ts);
  return date.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("uk-UA");
}

function formatCompact(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  const str = value.toFixed(1);
  return str.endsWith(".0") ? str.slice(0, -2) : str;
}

