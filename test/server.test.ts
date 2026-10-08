import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { ClaudeCli } from "../src/claude/claudeCli.ts";
import { createApp, hostGuard } from "../src/server.ts";
import { fixtureHome, put } from "./helpers.ts";

async function withServer(fn: (port: number) => Promise<void>) {
  const home = await fixtureHome();
  const cli = new ClaudeCli(async () => ({ stdout: "[]", stderr: "" }));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The guard needs the real port, which is only known after listen().
  const port = (server.address() as AddressInfo).port;
  server.on("request", createApp({ home, cli, port, starterPrompt: "go", defaultCwd: home, dataDir: `${home}/.ui` }));
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

// fetch() forbids overriding Host, so use raw http requests.
function request(
  port: number,
  opts: { method?: string; host?: string; origin?: string; body?: string; path?: string },
) {
  const headers: Record<string, string> = {
    host: opts.host ?? `127.0.0.1:${port}`,
    "content-type": "application/json",
  };
  if (opts.origin) headers.origin = opts.origin;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/api/agents", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

test("loopback host is allowed; foreign Host (DNS rebinding) is refused", async () => {
  await withServer(async (port) => {
    assert.equal((await request(port, {})).status, 200);
    assert.equal((await request(port, { host: `localhost:${port}` })).status, 200);
    assert.equal((await request(port, { host: `evil.example:${port}` })).status, 403);
    assert.equal((await request(port, { host: `127.0.0.1.evil.example:${port}` })).status, 403);
    // The guard is app-wide middleware, so every route group is covered by construction. Pinned
    // on the newest one anyway: a route registered above app.use() would quietly escape it.
    assert.equal((await request(port, { path: "/api/schedules" })).status, 200);
    assert.equal((await request(port, { path: "/api/schedules", host: `evil.example:${port}` })).status, 403);
  });
});

/** Drives the guard middleware directly; `status` stays 0 when it called next() instead. */
function callGuard(
  guard: ReturnType<typeof hostGuard>,
  headers: Record<string, string>,
  method = "GET",
): { status: number; nexted: boolean } {
  let status = 0;
  let nexted = false;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json() {},
  };
  guard({ headers, method } as never, res as never, () => {
    nexted = true;
  });
  return { status, nexted };
}

// Node's http client always sends a Host header, so the missing-header case is checked directly.
test("hostGuard refuses a missing Host and a loopback host on the wrong port", () => {
  const guard = hostGuard(3000);
  const call = (headers: Record<string, string>, method = "GET") => callGuard(guard, headers, method);
  assert.deepEqual(call({}), { status: 403, nexted: false });
  assert.deepEqual(call({ host: "127.0.0.1:3001" }), { status: 403, nexted: false });
  assert.deepEqual(call({ host: "127.0.0.1:3000" }), { status: 0, nexted: true });
  assert.deepEqual(call({ host: "localhost:3000" }), { status: 0, nexted: true });
  // A GET is exempt from the Origin check; a POST from another origin is not.
  assert.deepEqual(call({ host: "localhost:3000", origin: "http://evil.example" }), { status: 0, nexted: true });
  assert.deepEqual(call({ host: "localhost:3000", origin: "http://evil.example" }, "POST"), {
    status: 403,
    nexted: false,
  });
});

// Regression: --port 0 lets the OS choose, so a guard frozen on 0 would 403 the real URL.
test("hostGuard follows a port that is only known after listen()", () => {
  let bound = 0;
  const guard = hostGuard(() => bound);
  assert.deepEqual(callGuard(guard, { host: "127.0.0.1:54321" }), { status: 403, nexted: false });
  bound = 54321;
  assert.deepEqual(callGuard(guard, { host: "127.0.0.1:54321" }), { status: 0, nexted: true });
  assert.deepEqual(callGuard(guard, { host: "127.0.0.1:0" }), { status: 403, nexted: false });
});

test("a configured host is accepted in the Host header, and other names still are not", () => {
  const guard = hostGuard(3000, "192.168.1.42");
  assert.deepEqual(callGuard(guard, { host: "192.168.1.42:3000" }), { status: 0, nexted: true });
  // Loopback keeps working from the machine itself, and the rebinding guard is otherwise unchanged.
  assert.deepEqual(callGuard(guard, { host: "127.0.0.1:3000" }), { status: 0, nexted: true });
  assert.deepEqual(callGuard(guard, { host: "192.168.1.42:3001" }), { status: 403, nexted: false });
  assert.deepEqual(callGuard(guard, { host: "192.168.1.43:3000" }), { status: 403, nexted: false });
  assert.deepEqual(callGuard(guard, { host: "evil.example:3000" }), { status: 403, nexted: false });
  assert.deepEqual(callGuard(guard, { host: "192.168.1.42.evil.example:3000" }), { status: 403, nexted: false });
});

test("an IPv6 host is matched in its bracketed form, and a host with no port is refused", () => {
  const guard = hostGuard(3000, "fe80::1");
  assert.deepEqual(callGuard(guard, { host: "[fe80::1]:3000" }), { status: 0, nexted: true });
  assert.deepEqual(callGuard(guard, { host: "fe80::1:3000" }), { status: 403, nexted: false });
  assert.deepEqual(callGuard(guard, { host: "[fe80::1]" }), { status: 403, nexted: false });
  assert.deepEqual(callGuard(guard, { host: "127.0.0.1" }), { status: 403, nexted: false });
});

test("state-changing requests need a matching or absent Origin", async () => {
  await withServer(async (port) => {
    const body = JSON.stringify({ content: "x" });
    assert.equal((await request(port, { method: "POST", origin: "http://evil.example", body })).status, 403);
    // Same-origin and no-origin requests reach validation (400 for bad content), so the guard let them through.
    assert.equal((await request(port, { method: "POST", origin: `http://127.0.0.1:${port}`, body })).status, 400);
    assert.equal((await request(port, { method: "POST", body })).status, 400);
  });
});

test("malformed JSON body is a 400, not a 500", async () => {
  await withServer(async (port) => {
    assert.equal((await request(port, { method: "POST", body: "{bad" })).status, 400);
  });
});

test("the guard covers every route, including unknown ones", async () => {
  await withServer(async (port) => {
    for (const p of ["/api/config", "/api/runs", "/", "/nope"]) {
      assert.equal((await request(port, { host: "evil.example", path: p })).status, 403, p);
    }
  });
});

test("/api/config reports the ask default", async () => {
  await withServer(async (port) => {
    const { status, body } = await request(port, { path: "/api/config" });
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).permissionMode, "ask");
  });
});

test("agent listings never include the server-side file path", async () => {
  await withServer(async (port) => {
    const { body } = await request(port, { path: "/api/agents" });
    const agents = JSON.parse(body);
    assert.ok(agents.length > 0);
    for (const agent of agents) assert.equal("filePath" in agent, false);
  });
});

/** Same as withServer, but with a built client on disk so the history fallback has something to serve. */
async function withClient(fn: (port: number) => Promise<void>) {
  const home = await fixtureHome();
  const webRoot = path.join(home, "web");
  await put(path.join(webRoot, "index.html"), "<!doctype html><title>shell</title>");
  await put(path.join(webRoot, "assets", "app.js"), "export const x = 1;\n");
  const cli = new ClaudeCli(async () => ({ stdout: "[]", stderr: "" }));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    createApp({ home, cli, port, starterPrompt: "go", defaultCwd: home, dataDir: `${home}/.ui`, webRoot }),
  );
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

test("a client route reloads into the shell instead of 404ing", async () => {
  await withClient(async (port) => {
    for (const p of ["/", "/agents", "/skills", "/tasks", "/tasks/abc123", "/schedule"]) {
      const { status, body } = await request(port, { path: p });
      assert.equal(status, 200, p);
      assert.match(body, /<title>shell<\/title>/, p);
    }
    // A real asset still comes from disk, not from the fallback.
    const asset = await request(port, { path: "/assets/app.js" });
    assert.equal(asset.status, 200);
    assert.match(asset.body, /export const x/);
  });
});

test("the history fallback does not swallow a missing API route or a missing asset", async () => {
  await withClient(async (port) => {
    // HTML for a mistyped endpoint would make a 404 look like it worked.
    assert.equal((await request(port, { path: "/api/nope" })).status, 404);
    // HTML for a missing .js surfaces as a MIME error, hiding the file that is actually absent.
    assert.equal((await request(port, { path: "/assets/gone.js" })).status, 404);
    // Only GET/HEAD navigate; a POST to an unknown path is not a page load.
    assert.equal((await request(port, { method: "POST", path: "/tasks", body: "{}" })).status, 404);
  });
});
