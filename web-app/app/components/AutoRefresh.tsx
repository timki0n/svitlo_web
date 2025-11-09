"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type AutoRefreshProps = {
  intervalMs?: number;
};

export default function AutoRefresh({ intervalMs = 30_000 }: AutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }

      const remainder = Date.now() % intervalMs;
      const delay = remainder === 0 ? intervalMs : intervalMs - remainder;

      timeoutId = setTimeout(() => {
        if (cancelled) {
          return;
        }

        router.refresh();
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [router, intervalMs]);

  return null;
}

