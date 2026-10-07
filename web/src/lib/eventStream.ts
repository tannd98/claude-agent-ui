/**
 * The single SSE connection to `GET /api/events`.
 *
 * One connection per tab, shared by every screen. This is the only thing in the client that
 * learns the server changed: nothing polls. Screens read React Query caches, and the stream
 * invalidates them (see hooks/useEventStream.ts).
 *
 * The connection logic lives here rather than in a hook so it can be driven directly in a test
 * without a renderer, and so React Strict Mode's double-mount cannot open two sockets.
 */

/**
 * Event names the server emits. Mirrors RUN_EVENTS, AGENT_EVENTS and SKILL_EVENTS in
 * ../../src/events.ts, plus RESET_EVENT in ../../src/sse.ts.
 *
 * The `agent:*` and `skill:*` events cover edits made through this server — in another tab, or
 * by a background task. A file changed in an external editor produces none; nothing watches the
 * `.claude` trees.
 */
export const SERVER_EVENTS = {
  runStarted: "run:started",
  runStopped: "run:stopped",
  runRemoved: "run:removed",
  /**
   * The queue's notifications. `taskUpdated` covers every state transition, including entering
   * and leaving `waiting`, and the server emits it only on an observed change — so a task parked
   * on a permission prompt for ten minutes is one event, not one per poll.
   */
  taskCreated: "task:created",
  taskUpdated: "task:updated",
  taskRemoved: "task:removed",
  /**
   * The scheduler's notifications. `fired` and `skipped` carry their outcome inline
   * (`{ taskId, trigger }` / `{ reason, trigger }`) and `failed` carries `{ error }`, but the
   * client still re-reads `/api/schedules`: the same facts are recorded on the schedule itself,
   * so a tab that was asleep for an event is not left with a different story from one that
   * was not. See SCHEDULE_EVENTS in ../../src/events.ts.
   */
  scheduleCreated: "schedule:created",
  scheduleUpdated: "schedule:updated",
  scheduleRemoved: "schedule:removed",
  scheduleFired: "schedule:fired",
  scheduleSkipped: "schedule:skipped",
  scheduleFailed: "schedule:failed",
  agentCreated: "agent:created",
  agentUpdated: "agent:updated",
  agentRemoved: "agent:removed",
  skillCreated: "skill:created",
  skillUpdated: "skill:updated",
  skillRemoved: "skill:removed",
  /**
   * The client fell further behind than the server's replay buffer remembers, so there is
   * nothing to replay. Everything must be re-read rather than patched.
   */
  reset: "stream:reset",
} as const;

export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

export const ALL_EVENT_NAMES: readonly ServerEventName[] = Object.values(SERVER_EVENTS);

export interface StreamEvent {
  name: ServerEventName;
  /** The parsed `data:` payload, or null when the frame carried none. */
  data: unknown;
}

/** What the status bar renders. `connecting` covers both the first attempt and a reconnect. */
export type ConnectionState = "connecting" | "open" | "offline";

export interface EventStreamHandlers {
  onEvent: (event: StreamEvent) => void;
  onStateChange: (state: ConnectionState) => void;
}

export interface EventStreamOptions {
  url?: string;
  /** Injected in tests. Defaults to the platform `EventSource`. */
  eventSourceFactory?: (url: string) => EventSource;
  /** Injected in tests so backoff can be asserted without waiting. */
  now?: () => number;
}

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Full jitter exponential backoff: 1s, 2s, 4s … capped at 30s, each delay drawn uniformly from
 * `[0, ceiling)`. Jitter matters even for one client because a server restart reconnects every
 * open tab at once; a fixed ladder would have them all retry in lockstep.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

/**
 * Opens the stream and keeps it open. Returns a close function; calling it twice is harmless.
 *
 * `EventSource` reconnects on its own, but on its own schedule and without telling us it is
 * down, so this takes over: every error closes the socket, reports `offline`, and schedules the
 * next attempt itself. That is what makes the backoff observable and the status bar honest.
 */
export function connectEventStream(handlers: EventStreamHandlers, opts: EventStreamOptions = {}): () => void {
  const url = opts.url ?? "/api/events";
  const factory = opts.eventSourceFactory ?? ((u: string) => new EventSource(u));

  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    handlers.onStateChange("connecting");
    const es = factory(url);
    source = es;

    es.onopen = () => {
      attempt = 0;
      handlers.onStateChange("open");
    };

    es.onerror = () => {
      // Do not let EventSource run its own retry: close and schedule ours, so the backoff and
      // the reported state come from one place.
      es.close();
      if (source === es) source = null;
      if (stopped) return;
      handlers.onStateChange("offline");
      attempt += 1;
      retryTimer = setTimeout(open, backoffDelay(attempt));
    };

    for (const name of ALL_EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        handlers.onEvent({ name, data: parseData((ev as MessageEvent).data) });
      });
    }
  };

  open();

  return () => {
    if (stopped) return;
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    source?.close();
    source = null;
  };
}

/** A malformed frame must not take the stream down; it is reported as a null payload. */
function parseData(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
