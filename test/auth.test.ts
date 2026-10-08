import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { HINT_COOKIE, TOKEN_COOKIE, generateToken, parseCookies, tokensMatch } from "../src/auth.ts";
import { ClaudeCli } from "../src/claude/claudeCli.ts";
import { createApp } from "../src/server.ts";
import { fixtureHome } from "./helpers.ts";

const TOKEN = "s3cret-token-value";

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** Boots the app with (or without) a token and hands the test a request function bound to it. */
async function withServer(token: string | null, fn: (req: (opts: ReqOpts) => Promise<Reply>) => Promise<void>) {
  const home = await fixtureHome();
  const cli = new ClaudeCli(async () => ({ stdout: "[]", stderr: "" }));
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    createApp({ home, cli, port, token, starterPrompt: "go", defaultCwd: home, dataDir: `${home}/.ui` }),
  );
  try {
    await fn((opts) => request(port, opts));
  } finally {
    server.close();
  }
}

interface ReqOpts {
  path?: string;
  method?: string;
  bearer?: string;
  cookie?: string;
  accept?: string;
  origin?: string;
}

// Raw http rather than fetch: these assertions are about headers fetch will not let us set or
// redirects it would follow on its own.
function request(port: number, opts: ReqOpts): Promise<Reply> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.accept) headers.accept = opts.accept;
  if (opts.origin) headers.origin = opts.origin;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/api/agents", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The value a Set-Cookie response assigned to `name`, or undefined when it set none. */
function setCookie(reply: Reply, name: string): string | undefined {
  const line = (reply.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${name}=`));
  return line === undefined ? undefined : decodeURIComponent(line.slice(name.length + 1).split(";")[0]);
}

test("a generated token is long, URL-safe and never the same twice", () => {
  const a = generateToken();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(a, encodeURIComponent(a));
  assert.notEqual(a, generateToken());
});

test("tokensMatch compares whole tokens, including ones of different lengths", () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch("", ""), true);
  assert.equal(tokensMatch("s3cret-token-valuX", TOKEN), false);
  // A prefix must not pass, and a length mismatch must be a plain false rather than a throw.
  assert.equal(tokensMatch("s3cret", TOKEN), false);
  assert.equal(tokensMatch(`${TOKEN}-and-more`, TOKEN), false);
  assert.equal(tokensMatch("", TOKEN), false);
});

test("parseCookies reads the header browsers actually send", () => {
  assert.deepEqual(parseCookies("a=1; b=two"), { a: "1", b: "two" });
  assert.deepEqual(parseCookies(`${TOKEN_COOKIE}=${encodeURIComponent("a b+c")}`), { [TOKEN_COOKIE]: "a b+c" });
  assert.deepEqual(parseCookies(undefined), {});
  // Junk in the header must not take the readable pairs down with it.
  assert.deepEqual(parseCookies("broken; a=1; =2"), { a: "1" });
  // First wins, so a stale duplicate cannot shadow the cookie the server just set.
  assert.deepEqual(parseCookies("a=first; a=second"), { a: "first" });
});

test("with no token configured every route stays open", async () => {
  await withServer(null, async (req) => {
    assert.equal((await req({})).status, 200);
    assert.equal((await req({ path: "/api/config" })).status, 200);
    // And the client is told there is no session, so it offers no Sign out.
    assert.equal(JSON.parse((await req({ path: "/api/config" })).body).auth, false);
  });
});

test("with a token, an unauthenticated API request is 401 and says how to authenticate", async () => {
  await withServer(TOKEN, async (req) => {
    const reply = await req({});
    assert.equal(reply.status, 401);
    assert.match(JSON.parse(reply.body).error, /Authorization: Bearer/);
    // Every route group, not just the one: the guard is app-wide middleware.
    assert.equal((await req({ path: "/api/tasks" })).status, 401);
    assert.equal((await req({ path: "/api/schedules" })).status, 401);
    assert.equal((await req({ path: "/api/events" })).status, 401);
    assert.equal((await req({ path: "/api/config" })).status, 401);
  });
});

test("a bearer token authenticates, and a wrong one does not", async () => {
  await withServer(TOKEN, async (req) => {
    assert.equal((await req({ bearer: TOKEN })).status, 200);
    assert.equal((await req({ bearer: "wrong" })).status, 401);
    assert.equal((await req({ bearer: "" })).status, 401);
    assert.equal(JSON.parse((await req({ path: "/api/config", bearer: TOKEN })).body).auth, true);
  });
});

test("?token= is taken once, moved into a cookie, and redirected out of the address bar", async () => {
  await withServer(TOKEN, async (req) => {
    const reply = await req({ path: `/?token=${encodeURIComponent(TOKEN)}`, accept: "text/html" });
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, "/");
    assert.equal(setCookie(reply, TOKEN_COOKIE), TOKEN);
    // HttpOnly on the secret; readable on the hint the UI uses to offer Sign out.
    const cookies = reply.headers["set-cookie"] ?? [];
    assert.match(
      cookies.find((c) => c.startsWith(TOKEN_COOKIE))!,
      /HttpOnly/i,
    );
    assert.equal(setCookie(reply, HINT_COOKIE), "1");
    assert.doesNotMatch(
      cookies.find((c) => c.startsWith(HINT_COOKIE))!,
      /HttpOnly/i,
    );

    // The rest of the query survives the round trip; only the token is dropped.
    const kept = await req({ path: `/tasks?token=${encodeURIComponent(TOKEN)}&sort=age`, accept: "text/html" });
    assert.equal(kept.headers.location, "/tasks?sort=age");
  });
});

test("the cookie the redirect set authenticates later requests", async () => {
  await withServer(TOKEN, async (req) => {
    const reply = await req({ path: `/?token=${encodeURIComponent(TOKEN)}`, accept: "text/html" });
    const cookie = `${TOKEN_COOKIE}=${encodeURIComponent(setCookie(reply, TOKEN_COOKIE)!)}`;
    assert.equal((await req({ cookie })).status, 200);
    assert.equal((await req({ cookie: `${TOKEN_COOKIE}=stale` })).status, 401);
  });
});

test("a wrong ?token= falls through to the sign-in page rather than signing anyone in", async () => {
  await withServer(TOKEN, async (req) => {
    const reply = await req({ path: "/?token=wrong", accept: "text/html" });
    assert.equal(reply.status, 401);
    assert.equal(reply.headers["set-cookie"], undefined);
    assert.match(reply.body, /That token was not right/);
  });
});

test("a browser asking for a page gets the sign-in form; anything else gets JSON", async () => {
  await withServer(TOKEN, async (req) => {
    const page = await req({ path: "/tasks", accept: "text/html" });
    assert.equal(page.status, 401);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    // Scriptless and self-contained: it is served in front of the static files, so there is no
    // built client available to it.
    assert.match(page.body, /<form method="get" action="\/">/);
    assert.doesNotMatch(page.body, /<script/);
    // A mistyped API path must not answer in HTML — that reads as the endpoint working.
    const api = await req({ path: "/api/nope", accept: "text/html" });
    assert.equal(api.status, 401);
    assert.match(String(api.headers["content-type"]), /application\/json/);
  });
});

test("signing out clears both cookies and sends the browser back to the sign-in page", async () => {
  await withServer(TOKEN, async (req) => {
    const reply = await req({ path: "/api/auth/logout", method: "POST", bearer: TOKEN });
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, "/");
    const cleared = reply.headers["set-cookie"] ?? [];
    assert.equal(cleared.length, 2);
    for (const cookie of cleared) assert.match(cookie, /Expires=Thu, 01 Jan 1970/);

    // Unauthenticated, logging out is not something to offer: the guard answers first.
    assert.equal((await req({ path: "/api/auth/logout", method: "POST" })).status, 401);
  });
});
