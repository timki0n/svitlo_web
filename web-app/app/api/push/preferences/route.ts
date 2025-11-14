import { NextResponse } from "next/server";

import {
  NotificationPreferences,
  NotificationPreferencesPatch,
  REMINDER_LEAD_MINUTES,
  normalizePreferences,
  sanitizeLeadMinutes,
} from "@/lib/notificationPreferences";
import { getPreferencesByEndpoint, updatePreferencesForEndpoint } from "@/lib/pushDb";

type PatchBody = {
  endpoint?: string;
  preferences?: NotificationPreferencesPatch;
};

function parsePatch(raw: unknown): NotificationPreferencesPatch {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const patch: NotificationPreferencesPatch = {};

  if (typeof obj.actualEvents === "boolean") {
    patch.actualEvents = obj.actualEvents;
  }
  if (typeof obj.scheduleChanges === "boolean") {
    patch.scheduleChanges = obj.scheduleChanges;
  }
  if (obj.reminders && typeof obj.reminders === "object") {
    patch.reminders = patch.reminders ?? {};
    const reminders = obj.reminders as Record<string, unknown>;
    if (typeof reminders.enabled === "boolean") {
      patch.reminders.enabled = reminders.enabled;
    }
    if (Array.isArray(reminders.leadMinutes)) {
      patch.reminders.leadMinutes = sanitizeLeadMinutes(reminders.leadMinutes as number[]);
    }
  }

  return patch;
}

function responsePayload(preferences: NotificationPreferences) {
  return {
    ok: true,
    preferences,
    leadOptions: REMINDER_LEAD_MINUTES,
  };
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const endpoint = url.searchParams.get("endpoint")?.trim() ?? "";
  if (!endpoint) {
    return errorResponse("endpoint_required", 400);
  }
  try {
    const prefs = getPreferencesByEndpoint(endpoint);
    return NextResponse.json(responsePayload(prefs));
  } catch (error: any) {
    if (error instanceof Error && error.message === "subscription_not_found") {
      return errorResponse("subscription_not_found", 404);
    }
    return errorResponse("failed_to_load", 500);
  }
}

export async function PATCH(req: Request) {
  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return errorResponse("invalid_json", 400);
  }
  const endpoint = body.endpoint?.trim() ?? "";
  if (!endpoint) {
    return errorResponse("endpoint_required", 400);
  }
  const patch = parsePatch(body.preferences ?? {});
  if (
    typeof patch.actualEvents === "undefined" &&
    typeof patch.scheduleChanges === "undefined" &&
    typeof patch.reminders === "undefined"
  ) {
    return errorResponse("empty_patch", 400);
  }

  try {
    const updated = updatePreferencesForEndpoint(endpoint, patch);
    return NextResponse.json(responsePayload(updated));
  } catch (error: any) {
    if (error instanceof Error && error.message === "subscription_not_found") {
      return errorResponse("subscription_not_found", 404);
    }
    return errorResponse("failed_to_update", 500);
  }
}


