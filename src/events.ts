/**
 * The in-process event bus behind the SSE stream.
 *
 * Events are small notifications ("runs changed", "task finished"), never payload dumps: a client
 * that misses one re-reads the resource. That keeps the bus memory flat — the replay buffer is
 * capped, and a slow subscriber can be dropped instead of being buffered without limit.
 */

/**
 * Event names are `<namespace>:<verb>`. The namespaces are `run`, `task`, `schedule`, `agent` and
 * `skill`; clients subscribe to the ones they care about and re-read the matching resource when
 * one arrives.
 */
export const RUN_EVENTS = {
  started: "run:started",
  stopped: "run:stopped",
  removed: "run:removed",
} as const;

/**
 * The task queue's notifications, payload `{ taskId }` and nothing else.
 *
 * `updated` covers every state transition, including entering and leaving `waiting`, and the
 * watcher emits it only on an observed change — a task parked on a permission prompt for ten
 * minutes produces one event, not one per poll. `removed` is the history cap pruning a record;
 * a cancelled task keeps its row and reports `updated`.
 */
export const TASK_EVENTS = {
  created: "task:created",
  updated: "task:updated",
  removed: "task:removed",
} as const;

/**
 * The scheduler's notifications, payload `{ scheduleId }` plus what the client cannot re-read.
 *
 * `fired` and `skipped` carry the outcome inline — `{ taskId, trigger }` and `{ reason }` — because
 * a client watching the schedules screen wants to say "09:00 was suppressed, the previous run is
 * waiting on a permission prompt" without first correlating two resources. Both are also recorded
 * on the schedule itself, so a client that missed the event still sees why on its next read.
 *
 * `failed` is the fire that could not become a task at all (the agent was renamed, the working
 * directory is gone). A fire that silently does nothing is the one failure mode a scheduler must
 * never have, so it gets its own event rather than being folded into `skipped`.
 */
export const SCHEDULE_EVENTS = {
  created: "schedule:created",
  updated: "schedule:updated",
  removed: "schedule:removed",
  fired: "schedule:fired",
  skipped: "schedule:skipped",
  failed: "schedule:failed",
} as const;

/**
 * Definition files changed on disk through this server, payload `{ id }`.
 *
 * These are not a filesystem watcher: an agent file edited in another editor produces no event,
 * because watching every `.claude` tree recursively costs more than it is worth. The client
 * re-reads on navigation, and these events cover the edits it made itself in another tab.
 */
export const AGENT_EVENTS = {
  created: "agent:created",
  updated: "agent:updated",
  removed: "agent:removed",
} as const;

/** The skills equivalent of {@link AGENT_EVENTS}, with the same `{ id }` payload and caveat. */
export const SKILL_EVENTS = {
  created: "skill:created",
  updated: "skill:updated",
  removed: "skill:removed",
} as const;

export interface BusEvent<T = unknown> {
  /** Monotonic within one server process; used as the SSE `id:` field. */
  id: number;
  type: string;
  data: T;
  at: number;
}

export type Listener = (event: BusEvent) => void;

/** How many recent events are kept for reconnecting clients. */
export const DEFAULT_BUFFER_SIZE = 200;

export class EventBus {
  private listeners = new Set<Listener>();
  private buffer: BusEvent[] = [];
  private nextId = 1;
  private readonly bufferSize: number;

  constructor(opts: { bufferSize?: number } = {}) {
    this.bufferSize = Math.max(1, opts.bufferSize ?? DEFAULT_BUFFER_SIZE);
  }

  get lastEventId(): number {
    return this.nextId - 1;
  }

  emit<T>(type: string, data: T): BusEvent<T> {
    const event: BusEvent<T> = { id: this.nextId++, type, data, at: Date.now() };
    this.buffer.push(event as BusEvent);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const listener of [...this.listeners]) {
      try {
        listener(event as BusEvent);
      } catch {
        // One broken subscriber must not stop delivery to the others.
      }
    }
    return event;
  }

  /**
   * Events newer than `lastEventId` that are still buffered.
   * Returns null when the client is too far behind to be caught up — it should reload instead.
   */
  since(lastEventId: number): BusEvent[] | null {
    if (lastEventId >= this.lastEventId) return [];
    const oldest = this.buffer[0];
    if (oldest && lastEventId < oldest.id - 1) return null;
    return this.buffer.filter((e) => e.id > lastEventId);
  }

  /** Returns an unsubscribe function; calling it twice is harmless. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
