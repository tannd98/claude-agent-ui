import type { IncomingMessage, ServerResponse } from "node:http";
import type { BusEvent, EventBus } from "./events.ts";

/** Comment line sent on an idle stream so a dead connection is noticed from both ends. */
export const SSE_HEARTBEAT_MS = 15_000;
/** Reconnect delay suggested to the browser's EventSource. */
export const SSE_RETRY_MS = 2_000;
/**
 * Bytes we are willing to hold for a client that has stopped reading. Events are small
 * notifications, so a backlog this size means the client is gone or wedged: drop it and let it
 * reconnect rather than growing the buffer until the server runs out of memory.
 */
export const MAX_SSE_BACKLOG = 1024 * 1024;

/** Sent instead of a replay when the client is further behind than the bus still remembers. */
export const RESET_EVENT = "stream:reset";

/** One event in `text/event-stream` form. JSON.stringify never emits a raw newline, so one data line is enough. */
export function sseFrame(event: BusEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? null)}\n\n`;
}

/** Reads the resume point from the SSE reconnect header, falling back to the query string. */
export function parseLastEventId(req: IncomingMessage): number {
  const header = req.headers["last-event-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const raw = fromHeader ?? url.searchParams.get("lastEventId") ?? "";
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export interface StreamOptions {
  heartbeatMs?: number;
  maxBacklog?: number;
}

/**
 * Attaches one HTTP response to the bus as an SSE stream.
 *
 * Returns a close function; the stream also closes itself when the client disconnects or falls too
 * far behind. Everything it allocates — the subscription and the heartbeat timer — is released on
 * exactly one path, so a reload loop cannot leak subscribers.
 */
export function streamEvents(
  bus: EventBus,
  req: IncomingMessage,
  res: ServerResponse,
  opts: StreamOptions = {},
): () => void {
  const maxBacklog = opts.maxBacklog ?? MAX_SSE_BACKLOG;
  let closed = false;
  let unsubscribe: () => void = () => {};
  let heartbeat: NodeJS.Timeout | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };

  const push = (chunk: string) => {
    if (closed || res.writableEnded) return;
    res.write(chunk);
    if (res.writableLength > maxBacklog) close();
  };

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Harmless on loopback, and stops an intermediary from buffering the stream into silence.
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  req.socket?.setNoDelay(true);
  // An SSE connection is idle by design; the server's socket timeout must not reap it.
  res.setTimeout?.(0);

  push(`retry: ${SSE_RETRY_MS}\n\n`);

  const missed = bus.since(parseLastEventId(req));
  if (missed === null) {
    // Too far behind to be caught up from the buffer; the client re-reads the resources instead.
    push(`event: ${RESET_EVENT}\ndata: ${JSON.stringify({ lastEventId: bus.lastEventId })}\n\n`);
  } else {
    for (const event of missed) push(sseFrame(event));
  }

  unsubscribe = bus.subscribe((event) => push(sseFrame(event)));
  heartbeat = setInterval(() => push(": ping\n\n"), opts.heartbeatMs ?? SSE_HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  heartbeat.unref?.();

  res.on("close", close);
  res.on("error", close);

  return close;
}
