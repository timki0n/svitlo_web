"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { usePushSubscription } from "@/app/components/hooks/usePushSubscription";
import { useTheme } from "@/app/components/ThemeProvider";

export default function NotificationToggleIcon() {
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
