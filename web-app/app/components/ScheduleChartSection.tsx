"use client";

import { useEffect, useMemo, useState } from "react";
import { ScheduleChart } from "./ScheduleChart";
import type { WeekForChart } from "./scheduleTypes";

type ScheduleChartSectionProps = {
  weeks: WeekForChart[];
  isPowerOutNow?: boolean;
};

export function ScheduleChartSection({ weeks, isPowerOutNow = false }: ScheduleChartSectionProps) {
  const defaultIndex = useMemo(() => {
    if (weeks.length === 0) {
      return 0;
    }

    const now = Date.now();
    const matchIndex = weeks.findIndex((week) => {
      const start = Date.parse(week.startISO);
      const end = Date.parse(week.endISO);

      if (Number.isNaN(start) || Number.isNaN(end)) {
        return false;
      }

      const endOfWeek = new Date(end);
      endOfWeek.setHours(23, 59, 59, 999);

      return start <= now && now <= endOfWeek.getTime();
    });

    if (matchIndex !== -1) {
      return matchIndex;
    }

    return weeks.length - 1;
  }, [weeks]);

  const [currentIndex, setCurrentIndex] = useState(() =>
    Math.min(Math.max(defaultIndex, 0), Math.max(weeks.length - 1, 0))
  );

  useEffect(() => {
    if (weeks.length === 0) {
      setCurrentIndex(0);
      return;
    }

    const bounded = Math.min(Math.max(defaultIndex, 0), weeks.length - 1);
    setCurrentIndex(bounded);
  }, [defaultIndex, weeks.length]);

  const hasWeeks = weeks.length > 0;
  const currentWeek = hasWeeks ? weeks[Math.min(currentIndex, weeks.length - 1)] : null;

  const handlePrev = () => {
    setCurrentIndex((index) => Math.max(index - 1, 0));
  };

  const handleNext = () => {
    setCurrentIndex((index) => Math.min(index + 1, Math.max(weeks.length - 1, 0)));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          Графік планових та фактичних відключень
          {currentWeek ? ` (${currentWeek.rangeLabel})` : null}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            disabled={currentIndex <= 0}
            aria-label="Показати попередній тиждень"
            className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 text-lg text-zinc-600 transition enabled:hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:enabled:hover:bg-zinc-900"
          >
            ←
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={currentIndex >= weeks.length - 1}
            aria-label="Показати наступний тиждень"
            className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 text-lg text-zinc-600 transition enabled:hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:enabled:hover:bg-zinc-900"
          >
            →
          </button>
        </div>
      </div>
      {currentWeek ? (
        <ScheduleChart days={currentWeek.days} isPowerOutNow={isPowerOutNow} />
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Немає подій для відображення на графіку.
        </p>
      )}
    </div>
  );
}

