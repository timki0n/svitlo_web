"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function EventBridge() {
  const router = useRouter();

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as { type?: string };
        switch (payload.type) {
          case "schedule_updated":
          case "power_outage_started":
          case "power_restored":
            router.refresh();
            break;
          default:
            // ignore unknown events
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    // Optional: handle errors
    es.onerror = () => {
      // Let browser retry as advised by server "retry"
    };

    return () => {
      es.close();
    };
  }, [router]);

  return null;
}


