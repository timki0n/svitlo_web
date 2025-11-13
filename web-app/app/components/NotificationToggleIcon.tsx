"use client";

import { useEffect, useMemo, useState } from "react";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = typeof window !== "undefined" ? window.atob(base64) : "";
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function NotificationToggleIcon() {
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const publicKey = useMemo(() => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "", []);

  const isSupported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined";

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || !isSupported) return;
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      if (!reg) {
        setSubscribed(false);
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      setSubscribed(!!existing);
    });
  }, [mounted, isSupported]);

  const handleToggle = async () => {
    if (!isSupported || busy) return;
    setBusy(true);
    try {
      const reg =
        (await navigator.serviceWorker.getRegistration()) ||
        (await navigator.serviceWorker.register("/sw.js"));

      const current = await reg.pushManager.getSubscription();

      if (current) {
        // unsubscribe
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: current.endpoint }),
        });
        await current.unsubscribe();
        setSubscribed(false);
        return;
      }

      if (!publicKey) {
        // cannot subscribe without key
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return;
      }
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription),
      });
      setSubscribed(true);
    } finally {
      setBusy(false);
    }
  };

  if (!mounted || !isSupported) {
    return null;
  }

  const icon = subscribed ? "🔔" : "🔕";
  const title = subscribed ? "Нотифікації увімкнено" : "Нотифікації вимкнено";
  const ringClass = subscribed
    ? "shadow-[0_0_18px_rgba(16,185,129,0.45)] dark:shadow-[0_0_18px_rgba(16,185,129,0.35)]"
    : "shadow-none";

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={handleToggle}
      disabled={busy || (!publicKey && !subscribed)}
      className={`absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center rounded-full border border-zinc-400/60 bg-zinc-500/40 text-lg text-zinc-800 transition hover:bg-zinc-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-500/60 dark:bg-zinc-600/40 dark:text-zinc-200 dark:hover:bg-zinc-600/50 ${ringClass}`}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}


