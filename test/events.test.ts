import assert from "node:assert/strict";
import { test } from "node:test";
import { type BusEvent, EventBus } from "../src/events.ts";

test("emit delivers to every subscriber with increasing ids", () => {
  const bus = new EventBus();
  const a: BusEvent[] = [];
  const b: BusEvent[] = [];
  bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));
  bus.emit("runs.changed", { count: 1 });
  bus.emit("runs.changed", { count: 2 });
  assert.deepEqual(
    a.map((e) => e.id),
    [1, 2],
  );
  assert.deepEqual(
    b.map((e) => e.data),
    [{ count: 1 }, { count: 2 }],
  );
  assert.equal(bus.lastEventId, 2);
});

test("unsubscribe stops delivery and is safe to call twice", () => {
  const bus = new EventBus();
  const seen: BusEvent[] = [];
  const off = bus.subscribe((e) => seen.push(e));
  bus.emit("x", 1);
  off();
  off();
  bus.emit("x", 2);
  assert.equal(seen.length, 1);
  assert.equal(bus.subscriberCount, 0);
});

test("one throwing subscriber does not stop the others", () => {
  const bus = new EventBus();
  const seen: BusEvent[] = [];
  bus.subscribe(() => {
    throw new Error("broken client");
  });
  bus.subscribe((e) => seen.push(e));
  bus.emit("x", 1);
  assert.equal(seen.length, 1);
});

test("since() replays only what a reconnecting client missed", () => {
  const bus = new EventBus();
  bus.emit("a", 1);
  bus.emit("b", 2);
  bus.emit("c", 3);
  assert.deepEqual(
    bus.since(1)?.map((e) => e.type),
    ["b", "c"],
  );
  assert.deepEqual(bus.since(3), []);
  assert.deepEqual(bus.since(99), []);
});

test("the replay buffer is bounded, and a client too far behind is told to reload", () => {
  const bus = new EventBus({ bufferSize: 3 });
  for (let i = 0; i < 10; i++) bus.emit("x", i);
  // Only the last three events are still held, however many were emitted.
  assert.deepEqual(
    bus.since(9)?.map((e) => e.id),
    [10],
  );
  assert.deepEqual(
    bus.since(7)?.map((e) => e.id),
    [8, 9, 10],
  );
  assert.equal(bus.since(2), null);
});
