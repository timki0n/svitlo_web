"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { usePushSubscription } from "@/app/components/hooks/usePushSubscription";
import { useTheme } from "@/app/components/ThemeProvider";
import type { ReminderLeadMinutes } from "@/lib/notificationPreferences";

export default function Settings() {
  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const push = usePushSubscription();
  const theme = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !push.supported) {
    return null;
  }

  return (
    <>
      <FloatingSettingsButton
        isActive={push.subscribed}
        onClick={() => setIsOpen(true)}
      />

      <SettingsModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        notification={{
          subscribed: push.subscribed,
          busy: push.busy,
          canEnable: push.canEnable,
          ready: push.ready,
          onToggle: () => {
            void push.toggle();
          },
          preferences: push.preferences,
        }}
        theme={{
          value: theme.theme,
          ready: theme.ready,
          onToggle: theme.toggleTheme,
        }}
      />
    </>
  );
}

type FloatingSettingsButtonProps = {
  isActive: boolean;
  onClick: () => void;
};

function FloatingSettingsButton({ isActive, onClick }: FloatingSettingsButtonProps) {
  const ringClass = isActive
    ? "shadow-[0_0_18px_rgba(16,185,129,0.45)] dark:shadow-[0_0_18px_rgba(16,185,129,0.35)]"
    : "shadow-none";

  return (
    <button
      type="button"
      aria-label="Налаштування"
      title="Налаштування"
      onClick={onClick}
      className={`absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center rounded-full border border-zinc-400/60 bg-zinc-500/40 text-lg text-zinc-800 transition hover:bg-zinc-500/50 dark:border-zinc-500/60 dark:bg-zinc-600/40 dark:text-zinc-200 dark:hover:bg-zinc-600/50 ${ringClass}`}
    >
      <span aria-hidden="true">⚙️</span>
    </button>
  );
}

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  notification: {
    subscribed: boolean;
    busy: boolean;
    canEnable: boolean;
    ready: boolean;
    onToggle: () => void;
    preferences: ReturnType<typeof usePushSubscription>["preferences"];
  };
  theme: {
    value: "light" | "dark";
    ready: boolean;
    onToggle: () => void;
  };
};

function SettingsModal({ isOpen, onClose, notification, theme }: SettingsModalProps) {
  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  const notifDisabled =
    !notification.ready ||
    notification.busy ||
    (!notification.canEnable && !notification.subscribed);
  const notifTooltip =
    !notification.canEnable && !notification.subscribed
      ? "Відсутній публічний ключ VAPID"
      : undefined;

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Налаштування"
    >
      <button
        type="button"
        aria-label="Закрити налаштування"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      <div className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-300 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Налаштування
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label="Закрити"
          >
            ✖
          </button>
        </div>

        <div className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
          <SettingsToggle
            label="Отримувати сповіщення"
            description="Вмикає/вимикає push-сповіщення"
            checked={notification.subscribed}
            disabled={notifDisabled}
            loading={notification.busy}
            tooltip={notifTooltip}
            onChange={notification.onToggle}
          />
          {notification.subscribed ? (
            <NotificationPreferencesSection state={notification.preferences} />
          ) : null}

          <SettingsToggle
            label="Темна тема"
            description="За замовчуванням увімкнено"
            checked={theme.value === "dark"}
            disabled={!theme.ready}
            onChange={theme.onToggle}
          />
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

type NotificationPreferencesSectionProps = {
  state: ReturnType<typeof usePushSubscription>["preferences"];
};

function NotificationPreferencesSection({ state }: NotificationPreferencesSectionProps) {
  const { value, loading, saving, error, leadOptions, update } = state;
  const disabled = loading || saving;
  const statusMessage = error ?? (saving ? "Зберігаємо…" : loading ? "Завантаження..." : null);
  const handleToggle = (key: "actualEvents" | "scheduleChanges") => {
    if (key === "actualEvents") {
      void update({ actualEvents: !value.actualEvents });
    } else {
      void update({ scheduleChanges: !value.scheduleChanges });
    }
  };
  const handleReminderToggle = () => {
    if (value.reminders.enabled) {
      void update({ reminders: { enabled: false } });
      return;
    }
    if (value.reminders.leadMinutes.length === 0 && leadOptions.length > 0) {
      void update({
        reminders: {
          enabled: true,
          leadMinutes: [leadOptions[0]],
        },
      });
      return;
    }
    void update({ reminders: { enabled: true } });
  };
  const handleLeadToggle = (minutes: ReminderLeadMinutes) => {
    const current = new Set<ReminderLeadMinutes>(value.reminders.leadMinutes);
    if (current.has(minutes)) {
      current.delete(minutes);
    } else {
      current.add(minutes);
    }
    void update({
      reminders: {
        leadMinutes: Array.from(current).sort((a, b) => a - b),
      },
    });
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Налаштування сповіщень
      </p>
      <SettingsToggle
        label="Фактичні відключення"
        description="Сповіщати про реальні включення/відключення"
        checked={value.actualEvents}
        disabled={disabled}
        onChange={() => handleToggle("actualEvents")}
      />
      <SettingsToggle
        label="Зміни графіка"
        description="Сповіщати, коли DTEK оновлює розклад"
        checked={value.scheduleChanges}
        disabled={disabled}
        onChange={() => handleToggle("scheduleChanges")}
      />
      <SettingsToggle
        label="Нагадування"
        description="Нагадування про планові відключення/включення"
        checked={value.reminders.enabled}
        disabled={disabled}
        onChange={handleReminderToggle}
      />
      {value.reminders.enabled ? (
        <div className="flex flex-col gap-1 rounded-lg border border-emerald-200/60 bg-emerald-50/50 p-3 text-xs text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-900/20 dark:text-emerald-100">
          <span className="text-[11px] uppercase tracking-wide text-emerald-700 dark:text-emerald-200">
            Таймінг нагадувань
          </span>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {leadOptions.map((minutes) => {
              const active = value.reminders.leadMinutes.includes(minutes);
              return (
                <button
                  key={minutes}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => handleLeadToggle(minutes)}
                  className={`w-full rounded-full border px-3 py-1.5 text-sm transition ${
                    active
                      ? "border-emerald-500 bg-emerald-500 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-emerald-950"
                      : "border-emerald-600/50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-300/50 dark:text-emerald-100 dark:hover:bg-emerald-800/30"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {formatLeadLabel(minutes)}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-emerald-800/80 dark:text-emerald-100/80">
            Можна обрати кілька інтервалів. Нагадування будуть оновлювати сповіщення, а не додавати нове.
          </p>
        </div>
      ) : null}
      <div className="min-h-5 text-xs">
        {statusMessage ? (
          <span className={error ? "text-red-500 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"}>
            {statusMessage}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function formatLeadLabel(minutes: number) {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 год" : `${hours} год`;
  }
  return `${minutes} хв`;
}

type SettingsToggleProps = {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  onChange: () => void;
  tooltip?: string;
};

function SettingsToggle({
  label,
  description,
  checked,
  disabled,
  loading,
  onChange,
  tooltip,
}: SettingsToggleProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {label}
        </span>
        {description ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {description}
          </span>
        ) : null}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        title={tooltip}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
          checked ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span
          className={`inline-flex h-5 w-5 transform items-center justify-center rounded-full bg-white transition ${
            checked ? "translate-x-5" : "translate-x-1"
          }`}
        >
          {loading ? (
            <span className="h-2 w-2 animate-ping rounded-full bg-emerald-500" />
          ) : null}
        </span>
      </button>
    </div>
  );
}


