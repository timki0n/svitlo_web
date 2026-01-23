"use client";

import { useCallback, useEffect, useState } from "react";
import { VoltageChart } from "./VoltageChart";
import type { VoltageStats } from "@/lib/homeassistant";

const REFRESH_INTERVAL_MS = 60_000; // 1 хвилина, як і AutoRefresh

type FetchState =
  | { status: "idle" | "loading"; data: null }
  | { status: "success"; data: VoltageStats | null }
  | { status: "error"; data: null; message: string };

async function fetchVoltage(abortSignal?: AbortSignal) {
  const response = await fetch("/api/voltage", { cache: "no-store", signal: abortSignal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data: VoltageStats | null; error?: string };
  return payload.data ?? null;
}

export function VoltageChartLazy() {
  const [state, setState] = useState<FetchState>({ status: "loading", data: null });

  const doFetch = useCallback((controller: AbortController, isInitial: boolean) => {
    // Не показуємо loading при оновленні, лише при першому завантаженні
    if (isInitial) {
      setState({ status: "loading", data: null });
    }

    fetchVoltage(controller.signal)
      .then((data) => setState({ status: "success", data }))
      .catch((error) => {
        if (error.name === "AbortError") return;
        setState({ status: "error", data: null, message: "Не вдалося отримати дані" });
      });
  }, []);

  useEffect(() => {
    let controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    
    // Початкове завантаження
    doFetch(controller, true);

    // Інтервальне оновлення (синхронізовано з AutoRefresh)
    const scheduleNext = () => {
      if (cancelled) return;

      const remainder = Date.now() % REFRESH_INTERVAL_MS;
      const delay = remainder === 0 ? REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS - remainder;

      timeoutId = setTimeout(() => {
        if (cancelled) return;
        
        // Скасовуємо попередній запит якщо є
        controller.abort();
        controller = new AbortController();
        
        doFetch(controller, false);
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      controller.abort();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [doFetch]);

  const showLoader = state.status === "loading";
  const showError = state.status === "error";
  const stats = state.status === "success" ? state.data : null;

  if (showLoader) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white/70 p-4 text-sm text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
        Завантажуємо дані про напругу...
      </div>
    );
  }

  if (showError) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 text-sm text-rose-700 shadow-sm dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200">
        Не вдалося отримати дані про напругу. Спробуйте пізніше.
      </div>
    );
  }

  return <VoltageChart stats={stats} />;
}

