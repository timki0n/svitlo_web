type EventMessage = {
  type: string;
  title?: string;
  body?: string;
  data?: unknown;
  ts?: number;
};

type Subscriber = (event: EventMessage) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function broadcast(event: EventMessage) {
  const enriched = { ...event, ts: event.ts ?? Date.now() };
  for (const sub of subscribers) {
    try {
      sub(enriched);
    } catch {
      // ignore subscriber errors
    }
  }
}

export type { EventMessage };


