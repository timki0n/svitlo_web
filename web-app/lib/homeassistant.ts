/**
 * Home Assistant Integration
 * Модуль для отримання статистики з Home Assistant
 */

const HA_URL = process.env.HOME_ASSISTANT_URL ?? "";
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN ?? "";
const HA_TIMEOUT_MS = Number(process.env.HOME_ASSISTANT_TIMEOUT_MS ?? 5000);

export type VoltageHistoryEntry = {
  entity_id: string;
  state: string;
  last_changed: string;
  last_updated: string;
  attributes: Record<string, unknown>;
};

export type VoltageStats = {
  entityId: string;
  entries: Array<{
    timestamp: string;
    voltage: number | null;
  }>;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  fetchedAt: string;
};

/**
 * Отримує історію сенсора напруги з Home Assistant за останню добу
 */
export async function getVoltageHistory(): Promise<VoltageStats | null> {
  if (!HA_URL || !HA_TOKEN) {
    console.warn(
      "[HomeAssistant] Відсутні налаштування HOME_ASSISTANT_URL або HOME_ASSISTANT_TOKEN"
    );
    return null;
  }

  const sensorEntityId = "sensor.zbeacon_ts011f_napruga";
  
  // Розраховуємо час початку (24 години тому)
  const now = new Date();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  // Формат ISO для Home Assistant API
  const startTimeISO = startTime.toISOString();
  
  const url = `${HA_URL}/api/history/period/${startTimeISO}?filter_entity_id=${sensorEntityId}&minimal_response&no_attributes`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HA_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[HomeAssistant] Помилка API: ${response.status} ${response.statusText}`,
        errorText
      );
      return null;
    }

    const data = await response.json();
    
    // Home Assistant повертає масив масивів (по одному на кожен entity_id)
    if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[0])) {
      console.warn("[HomeAssistant] Неочікуваний формат відповіді:", data);
      return null;
    }

    const entries = data[0] as VoltageHistoryEntry[];
    
    // Парсимо значення напруги
    const parsedEntries = entries.map((entry) => {
      const voltage = parseFloat(entry.state);
      return {
        timestamp: entry.last_changed,
        voltage: Number.isNaN(voltage) ? null : voltage,
      };
    });

    // Фільтруємо тільки валідні значення для статистики
    const validVoltages = parsedEntries
      .map((e) => e.voltage)
      .filter((v): v is number => v !== null);

    const stats: VoltageStats = {
      entityId: sensorEntityId,
      entries: parsedEntries,
      count: parsedEntries.length,
      min: validVoltages.length > 0 ? Math.min(...validVoltages) : null,
      max: validVoltages.length > 0 ? Math.max(...validVoltages) : null,
      avg:
        validVoltages.length > 0
          ? validVoltages.reduce((a, b) => a + b, 0) / validVoltages.length
          : null,
      fetchedAt: now.toISOString(),
    };

    return stats;
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error).name === "AbortError") {
      console.warn("[HomeAssistant] Запит перевищив таймаут та був скасований");
      return null;
    }
    console.error("[HomeAssistant] Помилка при отриманні даних:", error);
    return null;
  }
}

