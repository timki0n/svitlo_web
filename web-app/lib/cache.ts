type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cacheStore = new Map<string, CacheEntry<unknown>>();

export function getCachedValue<T>(key: string, ttlMs: number, loader: () => T): T {
  if (ttlMs <= 0) {
    return loader();
  }

  const now = Date.now();
  const existing = cacheStore.get(key) as CacheEntry<T> | undefined;

  if (existing && existing.expiresAt > now) {
    return existing.value;
  }

  const value = loader();
  cacheStore.set(key, { value, expiresAt: now + ttlMs });

  return value;
}

export function clearCache(key?: string) {
  if (typeof key === "string") {
    cacheStore.delete(key);

    return;
  }

  cacheStore.clear();
}

