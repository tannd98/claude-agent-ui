/**
 * A minimal EventSource stand-in. jsdom does not implement one, and even where it does we want
 * to drive open/error/message by hand rather than over a real socket.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** The stream currently being driven, i.e. the most recent connection attempt. */
  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource was opened");
    return last;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  /* --- Test controls --------------------------------------------------------------- */

  open(): void {
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
  }

  /** Delivers one named event with a JSON payload, exactly as the server frames it. */
  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
