import { NextResponse } from "next/server";
import { subscribe, type EventMessage } from "@/lib/events";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const encoder = new TextEncoder();
  let closed = false;
  let pingId: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (msg: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(msg));
        } catch {
          closed = true;
        }
      };

      // Initial headers and retry advice
      send(`retry: 5000\n\n`);
      // Send a hello event
      const hello: EventMessage = { type: "hello", data: { ok: true }, ts: Date.now() } as any;
      send(`data: ${JSON.stringify(hello)}\n\n`);

      // Subscribe to broadcast bus
      unsubscribe = subscribe((event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keep-alive pings
      pingId = setInterval(() => {
        send(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      }, 25000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pingId) clearInterval(pingId);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      // Cleanup when client disconnects
      // Next.js provides abort signal on the incoming Request
      // Close and cleanup on abort
      // @ts-ignore - Request in this context has signal
      req.signal?.addEventListener?.("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (pingId) clearInterval(pingId);
      if (unsubscribe) unsubscribe();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}


