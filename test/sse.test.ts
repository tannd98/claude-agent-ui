import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCli } from "../src/claude/claudeCli.ts";
import { EventBus } from "../src/events.ts";
import { createApp } from "../src/server.ts";
import { RESET_EVENT, parseLastEventId, sseFrame, streamEvents } from "../src/sse.ts";
import { fixtureHome } from "./helpers.ts";

/** An open SSE connection, with the text received so far and a way to wait for more of it. */
interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  text(): string;
  waitFor(needle: string): Promise<void>;
  close(): void;
}

function connect(port: number, headers: Record<string, string> = {}, path = "/api/events"): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        const waiters: { needle: string; resolve: () => void }[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          for (const w of [...waiters]) {
            if (text.includes(w.needle)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve();
            }
          }
        });
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          text: () => text,
          waitFor: (needle) =>
            text.includes(needle)
              ? Promise.resolve()
              : new Promise<void>((res2, rej) => {
                  const timer = setTimeout(() => rej(new Error(`timed out waiting for ${needle} in: ${text}`)), 5_000);
                  waiters.push({
                    needle,
                    resolve: () => {
                      clearTimeout(timer);
                      res2();
                    },
                  });
                }),
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(fn: (port: number, bus: EventBus) => Promise<void>, bus = new EventBus()) {
  const home = await fixtureHome();
  const cli = new ClaudeCli(async () => ({ stdout: "[]", stderr: "" }));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    createApp({ home, cli, port, starterPrompt: "go", defaultCwd: home, dataDir: `${home}/.ui`, bus }),
  );
  try {
    await fn(port, bus);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** The bus drops a subscriber on the next tick after the socket closes. */
async function waitForSubscribers(bus: EventBus, count: number) {
  for (let i = 0; i < 100 && bus.subscriberCount !== count; i++) await delay(10);
  assert.equal(bus.subscriberCount, count);
}

test("sseFrame emits one id/event/data record per event", () => {
  assert.equal(
    sseFrame({ id: 7, type: "run:started", data: { runId: "r1" }, at: 0 }),
    'id: 7\nevent: run:started\ndata: {"runId":"r1"}\n\n',
  );
  // A multi-line string would break the framing if it were not JSON-encoded.
  assert.equal(sseFrame({ id: 1, type: "x", data: "a\nb", at: 0 }), 'id: 1\nevent: x\ndata: "a\\nb"\n\n');
});

test("parseLastEventId prefers the reconnect header and ignores nonsense", () => {
  const req = (headers: Record<string, string>, url = "/api/events") => ({ headers, url }) as never;
  assert.equal(parseLastEventId(req({ "last-event-id": "12" })), 12);
  assert.equal(parseLastEventId(req({}, "/api/events?lastEventId=5")), 5);
  assert.equal(parseLastEventId(req({ "last-event-id": "12" }, "/api/events?lastEventId=5")), 12);
  assert.equal(parseLastEventId(req({ "last-event-id": "nope" })), 0);
  assert.equal(parseLastEventId(req({ "last-event-id": "-3" })), 0);
  assert.equal(parseLastEventId(req({})), 0);
});

test("/api/events streams an emitted event to a connected client", async () => {
  await withServer(async (port, bus) => {
    const stream = await connect(port);
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
    assert.equal(stream.headers["cache-control"], "no-cache, no-transform");
    await stream.waitFor("retry: ");
    await waitForSubscribers(bus, 1);

    bus.emit("run:started", { runId: "r1" });
    await stream.waitFor('event: run:started\ndata: {"runId":"r1"}\n\n');
    bus.emit("task:finished", { taskId: "t1" });
    await stream.waitFor("event: task:finished");
    stream.close();
  });
});

test("a disconnect drops the subscriber, and later events still reach a new client", async () => {
  await withServer(async (port, bus) => {
    const first = await connect(port);
    await first.waitFor("retry: ");
    await waitForSubscribers(bus, 1);

    first.close();
    await waitForSubscribers(bus, 0);
    // Emitting with nobody listening must not throw, and must not resurrect the dead stream.
    bus.emit("run:stopped", { runId: "r1" });
    assert.doesNotMatch(first.text(), /run:stopped/);

    const second = await connect(port);
    await second.waitFor("retry: ");
    await waitForSubscribers(bus, 1);
    bus.emit("run:removed", { runId: "r1" });
    await second.waitFor("event: run:removed");
    second.close();
  });
});

test("a reconnect with Last-Event-ID replays only what was missed", async () => {
  await withServer(async (port, bus) => {
    bus.emit("run:started", { runId: "a" });
    bus.emit("run:started", { runId: "b" });
    bus.emit("run:started", { runId: "c" });
    const stream = await connect(port, { "last-event-id": "1" });
    await stream.waitFor('data: {"runId":"c"}');
    assert.doesNotMatch(stream.text(), /"runId":"a"/);
    assert.match(stream.text(), /id: 2\n/);
    stream.close();
  });
});

test("a client too far behind is told to reset instead of being replayed", async () => {
  const bus = new EventBus({ bufferSize: 2 });
  await withServer(async (port) => {
    for (let i = 0; i < 10; i++) bus.emit("run:started", { runId: String(i) });
    const stream = await connect(port, { "last-event-id": "1" });
    await stream.waitFor(`event: ${RESET_EVENT}`);
    await stream.waitFor('{"lastEventId":10}');
    stream.close();
  }, bus);
});

test("the heartbeat keeps an idle stream alive", async () => {
  const bus = new EventBus();
  const server = http.createServer((req, res) => streamEvents(bus, req, res, { heartbeatMs: 20 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const stream = await connect(port, {}, "/");
    await stream.waitFor(": ping\n\n");
    stream.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/** Minimal ServerResponse stand-in whose write buffer never drains, like a client that stopped reading. */
function stalledResponse() {
  const handlers = new Map<string, () => void>();
  return {
    writableEnded: false,
    writableLength: 0,
    chunks: [] as string[],
    writeHead() {},
    flushHeaders() {},
    setTimeout() {},
    write(chunk: string) {
      this.chunks.push(chunk);
      this.writableLength += chunk.length;
      return false;
    },
    end() {
      this.writableEnded = true;
    },
    on(event: string, fn: () => void) {
      handlers.set(event, fn);
      return this;
    },
  };
}

test("a client that stops reading is dropped rather than buffered without limit", () => {
  const bus = new EventBus();
  const res = stalledResponse();
  const req = { headers: {}, url: "/api/events", socket: { setNoDelay() {} } };
  streamEvents(bus, req as never, res as never, { maxBacklog: 200 });
  assert.equal(bus.subscriberCount, 1);

  for (let i = 0; i < 50 && !res.writableEnded; i++) bus.emit("run:started", { runId: `run-${i}` });
  assert.equal(res.writableEnded, true, "the stalled client should have been closed");
  assert.equal(bus.subscriberCount, 0, "its subscription must go with it");
  assert.ok(res.writableLength < 1_000, `buffered ${res.writableLength} bytes before giving up`);

  // Nothing is written to it afterwards, however much is emitted.
  const after = res.chunks.length;
  bus.emit("run:started", { runId: "late" });
  assert.equal(res.chunks.length, after);
});
