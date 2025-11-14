export const REMINDER_LEAD_MINUTES = [10, 20, 30, 60] as const;
export type ReminderLeadMinutes = (typeof REMINDER_LEAD_MINUTES)[number];
const DEFAULT_REMINDER_LEAD: ReminderLeadMinutes = REMINDER_LEAD_MINUTES[0];

export type PushCategory = "actual" | "schedule_change" | "reminder";

export type NotificationPreferences = {
  actualEvents: boolean;
  scheduleChanges: boolean;
  reminders: {
    enabled: boolean;
    leadMinutes: ReminderLeadMinutes[];
  };
};

export type NotificationPreferencesPatch = Partial<Omit<NotificationPreferences, "reminders">> & {
  reminders?: Partial<NotificationPreferences["reminders"]>;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  actualEvents: true,
  scheduleChanges: true,
  reminders: {
    enabled: false,
    leadMinutes: [DEFAULT_REMINDER_LEAD],
  },
};

export function normalizePreferences(raw: unknown): NotificationPreferences {
  const base = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (!raw || typeof raw !== "object") {
    return base;
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.actualEvents === "boolean") {
    base.actualEvents = obj.actualEvents;
  }
  if (typeof obj.scheduleChanges === "boolean") {
    base.scheduleChanges = obj.scheduleChanges;
  }

  const remindersRaw = obj.reminders;
  if (remindersRaw && typeof remindersRaw === "object") {
    const remindersObj = remindersRaw as Record<string, unknown>;
    if (typeof remindersObj.enabled === "boolean") {
      base.reminders.enabled = remindersObj.enabled;
    }
    if (Array.isArray(remindersObj.leadMinutes)) {
      base.reminders.leadMinutes = sanitizeLeadMinutes(remindersObj.leadMinutes);
    }
  }

  if (!base.reminders.leadMinutes.length) {
    base.reminders.leadMinutes = [DEFAULT_REMINDER_LEAD];
  }

  return {
    ...base,
    reminders: {
      ...base.reminders,
      leadMinutes: [...base.reminders.leadMinutes],
    },
  };
}

export function applyPreferencesPatch(
  source: NotificationPreferences,
  patch: NotificationPreferencesPatch
): NotificationPreferences {
  const merged: NotificationPreferences = {
    actualEvents:
      typeof patch.actualEvents === "boolean" ? patch.actualEvents : source.actualEvents,
    scheduleChanges:
      typeof patch.scheduleChanges === "boolean"
        ? patch.scheduleChanges
        : source.scheduleChanges,
    reminders: {
      enabled:
        typeof patch.reminders?.enabled === "boolean"
          ? patch.reminders.enabled
          : source.reminders.enabled,
      leadMinutes: source.reminders.leadMinutes,
    },
  };

  if (patch.reminders?.leadMinutes) {
    merged.reminders.leadMinutes = sanitizeLeadMinutes(patch.reminders.leadMinutes);
  } else {
    merged.reminders.leadMinutes = [...source.reminders.leadMinutes];
  }

  if (!merged.reminders.leadMinutes.length) {
    merged.reminders.leadMinutes = [DEFAULT_REMINDER_LEAD];
  }

  return merged;
}

export function sanitizeLeadMinutes(
  input: readonly number[] | undefined | null
): ReminderLeadMinutes[] {
  if (!input || input.length === 0) {
    return [];
  }
  const allowed = new Set<number>(REMINDER_LEAD_MINUTES);
  const unique = new Set<ReminderLeadMinutes>();
  for (const value of input) {
    if (allowed.has(value)) {
      unique.add(value as ReminderLeadMinutes);
    }
  }
  return Array.from(unique).sort((a, b) => a - b);
}


