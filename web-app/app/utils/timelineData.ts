import type { SnakeTimelineData, SnakeTimelineSlot } from "@/app/components/SnakeDayTimeline";

type TimelineDataParseResult = {
  data: SnakeTimelineData | null;
  error?: string;
};

const TOTAL_SLOTS = 24;

export function parseTimelineDataParam(rawParam?: string | null): TimelineDataParseResult {
  if (!rawParam) {
    return { data: null, error: "Не передано query-параметр `data`." };
  }

  const trimmed = rawParam.trim();
  if (!trimmed) {
    return { data: null, error: "Порожнє значення параметра `data`." };
  }

  let jsonPayload: string | null = null;
  if (looksLikeJson(trimmed)) {
    jsonPayload = trimmed;
  } else {
    try {
      jsonPayload = decodeBase64Payload(trimmed);
    } catch {
      return { data: null, error: "Не вдалося декодувати base64-параметр `data`." };
    }
  }

  const parsed = tryParseJson(jsonPayload);
  if (!parsed) {
    return { data: null, error: "Невалідний JSON у параметрі `data`." };
  }

  const normalised = normaliseTimelineData(parsed);
  if (!normalised) {
    return { data: null, error: "JSON не відповідає структурі SnakeTimelineData." };
  }

  return { data: normalised };
}

export function buildPlaceholderTimelineData(overrides?: Partial<SnakeTimelineData>): SnakeTimelineData {
  const now = new Date();
  const baseSummary = normaliseSummary({});
  const base: SnakeTimelineData = {
    slots: buildEmptySlots(),
    dayLabel: formatReadableDayLabel(now),
    dateLabel: formatCalendarDate(now),
    nowHour: getHourFraction(now),
    status: null,
    hasPlanSegments: false,
    isPlaceholder: true,
    currentTimeLabel: formatTime(now),
    summary: {
      ...baseSummary,
      outageHours: 0,
      lightHours: 24,
      hasActualData: false,
    },
    contextLabel: "Сьогодні",
    showCurrentTimeIndicator: true,
  };

  if (!overrides) {
    return base;
  }

  return {
    ...base,
    ...overrides,
    slots: overrides.slots ?? base.slots,
    summary: {
      ...base.summary,
      ...(overrides.summary ?? {}),
    },
  };
}

function normaliseTimelineData(input: unknown): SnakeTimelineData | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const source = input as Record<string, unknown>;
  const now = new Date();
  const slots = normaliseSlots(source.slots);
  const nowHour = clampHour(asNumber(source.nowHour, getHourFraction(now)));
  const status = typeof source.status === "string" ? source.status : null;
  const hasPlanSegments = typeof source.hasPlanSegments === "boolean" ? source.hasPlanSegments : slots.some((slot) => slot.fillRatio > 0);
  const isPlaceholder = typeof source.isPlaceholder === "boolean" ? source.isPlaceholder : !hasPlanSegments;
  const summary = normaliseSummary(source.summary);
  const contextLabel = asOptionalString(source.contextLabel);
  const showCurrentTimeIndicator =
    typeof source.showCurrentTimeIndicator === "boolean" ? source.showCurrentTimeIndicator : true;

  return {
    slots,
    dayLabel: asNonEmptyString(source.dayLabel, "Сьогодні"),
    dateLabel: asNonEmptyString(source.dateLabel, formatCalendarDate(now)),
    nowHour,
    status,
    hasPlanSegments,
    isPlaceholder,
    currentTimeLabel: asNonEmptyString(source.currentTimeLabel, formatTime(now)),
    summary,
    contextLabel: contextLabel ?? "Сьогодні",
    showCurrentTimeIndicator,
  };
}

function normaliseSlots(slotsInput: unknown): SnakeTimelineSlot[] {
  if (!Array.isArray(slotsInput) || slotsInput.length === 0) {
    return buildEmptySlots();
  }

  const slots = slotsInput
    .slice(0, TOTAL_SLOTS)
    .map((slot, index) => normaliseSlot(slot, index))
    .filter((slot): slot is SnakeTimelineSlot => Boolean(slot));

  while (slots.length < TOTAL_SLOTS) {
    slots.push(buildEmptySlot(slots.length));
  }

  return slots;
}

function normaliseSlot(input: unknown, fallbackIndex: number): SnakeTimelineSlot | null {
  if (!input || typeof input !== "object") {
    return buildEmptySlot(fallbackIndex);
  }

  const source = input as Record<string, unknown>;
  const startHour = clampHour(asNumber(source.startHour, fallbackIndex));
  const defaultEndHour = Math.min(24, startHour + 1);
  let endHour = clampHour(asNumber(source.endHour, defaultEndHour));
  if (endHour <= startHour) {
    endHour = defaultEndHour;
  }

  return {
    index: clampIndex(asNumber(source.index, fallbackIndex)),
    startHour,
    endHour,
    fillRatio: clampRatio(asNumber(source.fillRatio, 0)),
    fillStartRatio: clampRatio(asNumber(source.fillStartRatio, 0)),
  };
}

function normaliseSummary(input: unknown): SnakeTimelineData["summary"] {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const plannedHours = clampDuration(asNumber(source.plannedHours, 0));
  const actualHours = clampDuration(asNumber(source.actualHours, 0));
  const outageHours = clampDuration(asNumber(source.outageHours, actualHours));
  const lightHours = clampDuration(asNumber(source.lightHours, 24 - outageHours));
  const diffHours = asNumber(source.diffHours, plannedHours - actualHours);
  const hasActualData = typeof source.hasActualData === "boolean" ? source.hasActualData : outageHours > 0;

  return {
    plannedHours,
    actualHours,
    outageHours,
    lightHours,
    diffHours,
    hasActualData,
  };
}

function buildEmptySlots() {
  return Array.from({ length: TOTAL_SLOTS }, (_, index) => buildEmptySlot(index));
}

function buildEmptySlot(index: number): SnakeTimelineSlot {
  const startHour = index;
  const endHour = Math.min(24, startHour + 1);

  return {
    index,
    startHour,
    endHour,
    fillRatio: 0,
    fillStartRatio: 0,
  };
}

function tryParseJson(payload: string | null): unknown | null {
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function decodeBase64Payload(raw: string): string {
  const sanitized = raw.replace(/\s+/g, "");
  if (!sanitized) {
    throw new Error("Empty base64 payload");
  }

  if (typeof window !== "undefined" && typeof window.atob === "function") {
    return window.atob(sanitized);
  }

  return Buffer.from(sanitized, "base64").toString("utf-8");
}

function looksLikeJson(value: string) {
  const firstChar = value.trimStart().charAt(0);
  return firstChar === "{" || firstChar === "[";
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNonEmptyString(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampHour(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 24) {
    return 24;
  }
  return value;
}

function clampDuration(value: number) {
  return clampHour(value);
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function clampIndex(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value >= TOTAL_SLOTS) {
    return TOTAL_SLOTS - 1;
  }
  return Math.floor(value);
}

function getHourFraction(date: Date) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

function formatTime(date: Date) {
  return new Intl.DateTimeFormat("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatReadableDayLabel(date: Date) {
  const weekday = new Intl.DateTimeFormat("uk-UA", { weekday: "long" })
    .format(date)
    .replace(".", "");
  const capitalisedWeekday = weekday ? `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}` : "";
  const dayMonth = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit" }).format(date);
  return `${capitalisedWeekday} (${dayMonth})`;
}

function formatCalendarDate(date: Date) {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

