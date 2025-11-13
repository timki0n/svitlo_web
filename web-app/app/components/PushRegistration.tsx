"use client";

import { useEffect, useMemo, useState } from "react";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function PushRegistration() {
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const publicKey = useMemo(() => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "", []);
  const isSupported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isSupported) return;
    // Detect existing subscription
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      if (!reg) {
        setSubscribed(false);
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      setSubscribed(!!existing);
    });
  }, [isSupported]);

  const enable = async () => {
    if (!isSupported || !publicKey) return;
    setLoading(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setLoading(false);
        return;
      }
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register("/sw.js"));
      const subscription =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription),
      });
      setSubscribed(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const disable = async () => {
    if (!isSupported) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  // Уникаємо розбіжностей SSR/CSR: поки не змонтовано — нічого не рендеримо
  if (!mounted) {
    return null;
  }

  if (!isSupported) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        type="button"
        disabled={loading || (!publicKey && !subscribed)}
        onClick={subscribed ? disable : enable}
        className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-sm transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        aria-label={subscribed ? "Вимкнути нотифікації" : "Увімкнути нотифікації"}
        title={publicKey ? "" : "Відсутній публічний ключ VAPID"}
      >
        {subscribed ? "Нотифікації: увімкнено" : "Увімкнути нотифікації"}
      </button>
    </div>
  );
}


