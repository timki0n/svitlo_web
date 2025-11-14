"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferences,
  NotificationPreferencesPatch,
  REMINDER_LEAD_MINUTES,
  ReminderLeadMinutes,
  applyPreferencesPatch,
  normalizePreferences,
} from "@/lib/notificationPreferences";

type NotificationPreferencesState = {
  value: NotificationPreferences;
  loading: boolean;
  saving: boolean;
  error: string | null;
  leadOptions: readonly ReminderLeadMinutes[];
  update: (patch: NotificationPreferencesPatch) => Promise<void>;
  refetch: () => Promise<void>;
};

type UsePushSubscriptionResult = {
  subscribed: boolean;
  busy: boolean;
  ready: boolean;
  supported: boolean;
  canEnable: boolean;
  toggle: () => Promise<void>;
  preferences: NotificationPreferencesState;
};

const DEFAULT_PREFS_FACTORY = () => normalizePreferences(DEFAULT_NOTIFICATION_PREFERENCES);

export function usePushSubscription(): UsePushSubscriptionResult {
  const [subscribed, setSubscribed] = useState(false);
  const [subscriptionEndpoint, setSubscriptionEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFS_FACTORY);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const publicKey = useMemo(() => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "", []);

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
    const detect = async () => {
      try {
        const reg =
          (await navigator.serviceWorker.getRegistration()) ||
          (await navigator.serviceWorker.register("/sw.js"));
        if (cancelled) {
          return;
        }
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) {
          return;
        }
        setSubscribed(Boolean(existing));
        setSubscriptionEndpoint(existing?.endpoint ?? null);
        setReady(true);
      } catch {
        if (!cancelled) {
          setSubscribed(false);
          setSubscriptionEndpoint(null);
          setReady(true);
        }
      }
    };

    void detect();

    return () => {
      cancelled = true;
    };
  }, [supported]);

  const resetPreferencesToDefault = useCallback(() => {
    setPreferences(DEFAULT_PREFS_FACTORY());
    setPrefsError(null);
    setPrefsLoading(false);
    setPrefsSaving(false);
  }, []);

  const fetchPreferences = useCallback(
    async (endpoint: string, opts?: { silent?: boolean }) => {
      if (!endpoint) {
        resetPreferencesToDefault();
        return;
      }
      if (!opts?.silent) {
        setPrefsLoading(true);
      }
      setPrefsError(null);
      try {
        const res = await fetch(
          `/api/push/preferences?endpoint=${encodeURIComponent(endpoint)}`
        );
        if (!res.ok) {
          if (res.status === 404) {
            resetPreferencesToDefault();
            return;
          }
          const message = await extractErrorMessage(res);
          console.warn("preferences fetch failed", res.status, message);
          setPrefsError(message ?? "Не вдалося завантажити налаштування");
          return;
        }
        const json = (await res.json()) as { preferences: NotificationPreferences };
        setPreferences(normalizePreferences(json.preferences));
      } catch (error) {
        console.error("preferences fetch error", error);
        setPrefsError("Не вдалося завантажити налаштування");
      } finally {
        if (!opts?.silent) {
          setPrefsLoading(false);
        }
      }
    },
    [resetPreferencesToDefault]
  );

  useEffect(() => {
    if (!subscriptionEndpoint || !subscribed) {
      resetPreferencesToDefault();
      return;
    }
    setPrefsLoading(true);
    void fetchPreferences(subscriptionEndpoint);
  }, [subscriptionEndpoint, subscribed, fetchPreferences, resetPreferencesToDefault]);

  const refetchPreferences = useCallback(async () => {
    if (!subscriptionEndpoint) {
      return;
    }
    await fetchPreferences(subscriptionEndpoint);
  }, [subscriptionEndpoint, fetchPreferences]);

  const updatePreferences = useCallback(
    async (patch: NotificationPreferencesPatch) => {
      if (!subscriptionEndpoint) {
        return;
      }
      setPrefsSaving(true);
      setPrefsError(null);
      setPreferences((prev) => applyPreferencesPatch(prev, patch));
      try {
        const res = await fetch("/api/push/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: subscriptionEndpoint,
            preferences: patch,
          }),
        });
        if (!res.ok) {
          const message = await extractErrorMessage(res);
          throw new Error(message ?? "failed");
        }
        const json = (await res.json()) as { preferences: NotificationPreferences };
        setPreferences(normalizePreferences(json.preferences));
      } catch (error) {
        console.error("preferences update error", error);
        setPrefsError("Не вдалося зберегти налаштування");
        await fetchPreferences(subscriptionEndpoint, { silent: true });
      } finally {
        setPrefsSaving(false);
      }
    },
    [subscriptionEndpoint, fetchPreferences]
  );

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
        setSubscriptionEndpoint(null);
        resetPreferencesToDefault();
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
      setSubscriptionEndpoint(subscription.endpoint);
    } finally {
      setBusy(false);
    }
  }, [supported, busy, publicKey, resetPreferencesToDefault]);

  return {
    subscribed,
    busy,
    ready,
    supported,
    canEnable: Boolean(publicKey || subscribed),
    toggle,
    preferences: {
      value: preferences,
      loading: prefsLoading,
      saving: prefsSaving,
      error: prefsError,
      leadOptions: REMINDER_LEAD_MINUTES,
      update: updatePreferences,
      refetch: refetchPreferences,
    },
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

async function extractErrorMessage(res: Response): Promise<string | null> {
  try {
    const data = await res.json();
    if (data && typeof data.error === "string" && data.error.trim()) {
      return data.error.trim();
    }
  } catch {
    // ignore json parse errors
  }
  try {
    const text = await res.text();
    return text?.trim() || null;
  } catch {
    return null;
  }
}

