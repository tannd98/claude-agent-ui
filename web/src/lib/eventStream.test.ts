import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource } from "../test/fakeEventSource.ts";
import { SERVER_EVENTS, backoffDelay, connectEventStream, type ConnectionState } from "./eventStream.ts";

const factory = (url: string) => new FakeEventSource(url) as unknown as EventSource;

describe("backoffDelay", () => {
  it("doubles the ceiling per attempt and caps at 30s", () => {
    const atCeiling = () => 1;
    expect(backoffDelay(1, atCeiling)).toBe(1_000);
    expect(backoffDelay(2, atCeiling)).toBe(2_000);
    expect(backoffDelay(3, atCeiling)).toBe(4_000);
    expect(backoffDelay(10, atCeiling)).toBe(30_000);
    expect(backoffDelay(99, atCeiling)).toBe(30_000);
  });

  it("draws from the full range so reconnecting tabs do not retry in lockstep", () => {
    expect(backoffDelay(3, () => 0)).toBe(0);
    expect(backoffDelay(3, () => 0.5)).toBe(2_000);
  });
});

describe("connectEventStream", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens exactly one connection and reports its state", () => {
    const states: ConnectionState[] = [];
    const close = connectEventStream(
      { onEvent: () => {}, onStateChange: (s) => states.push(s) },
      { eventSourceFactory: factory },
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(states).toEqual(["connecting"]);

    FakeEventSource.latest.open();
    expect(states).toEqual(["connecting", "open"]);

    close();
  });

  it("delivers parsed server events", () => {
    const seen: { name: string; data: unknown }[] = [];
    const close = connectEventStream(
      { onEvent: (e) => seen.push(e), onStateChange: () => {} },
      { eventSourceFactory: factory },
    );

    FakeEventSource.latest.open();
    FakeEventSource.latest.emit(SERVER_EVENTS.runStarted, { runId: "run-7f2a" });

    expect(seen).toEqual([{ name: SERVER_EVENTS.runStarted, data: { runId: "run-7f2a" } }]);
    close();
  });

  it("goes offline on error and reconnects on a backoff, not immediately", () => {
    const states: ConnectionState[] = [];
    const close = connectEventStream(
      { onEvent: () => {}, onStateChange: (s) => states.push(s) },
      { eventSourceFactory: factory },
    );

    FakeEventSource.latest.open();
    const first = FakeEventSource.latest;
    first.fail();

    expect(first.closed).toBe(true);
    expect(states.at(-1)).toBe("offline");
    // Still one connection: nothing reconnects synchronously.
    expect(FakeEventSource.instances).toHaveLength(1);

    // The first retry ceiling is 1s, so advancing past it must have opened a second.
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");

    close();
  });

  it("stops reconnecting once closed", () => {
    const close = connectEventStream({ onEvent: () => {}, onStateChange: () => {} }, { eventSourceFactory: factory });

    const source = FakeEventSource.latest;
    close();
    expect(source.closed).toBe(true);

    source.fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("survives a frame whose payload is not JSON", () => {
    const seen: unknown[] = [];
    const close = connectEventStream(
      { onEvent: (e) => seen.push(e.data), onStateChange: () => {} },
      { eventSourceFactory: factory },
    );

    const source = FakeEventSource.latest;
    source.open();
    for (const listener of source.listeners.get(SERVER_EVENTS.runStopped) ?? []) {
      listener(new MessageEvent(SERVER_EVENTS.runStopped, { data: "not json{" }));
    }

    expect(seen).toEqual([null]);
    close();
  });
});
