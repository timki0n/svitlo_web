"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type UsePushSubscriptionResult = {
  subscribed: boolean;
  busy: boolean;
  ready: boolean;
  supported: boolean;
  canEnable: boolean;
  toggle: () => Promise<void>;
};

export function usePushSubscription(): UsePushSubscriptionResult {
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const publicKey = useMemo(
    () => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "",
    []
  );

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined";

  useEffect(() => {
    if (!supported) {
      setReady(true);
      return;
    }

    let cancelled = false;
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      if (cancelled) {
        return;
      }

      if (!reg) {
        setSubscribed(false);
        setReady(true);
        return;
      }

      const existing = await reg.pushManager.getSubscription();
      if (!cancelled) {
        setSubscribed(!!existing);
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [supported]);

  const toggle = useCallback(async () => {
    if (!supported || busy) {
      return;
    }
    setBusy(true);

    try {
      const reg =
        (await navigator.serviceWorker.getRegistration()) ||
        (await navigator.serviceWorker.register("/sw.js"));

      const current = await reg.pushManager.getSubscription();

      if (current) {
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
  }, [supported, busy, publicKey]);

  return {
    subscribed,
    busy,
    ready,
    supported,
    canEnable: Boolean(publicKey || subscribed),
    toggle,
  };
}

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


