/**
 * A single shared token in front of every route.
 *
 * Deliberately one token and no accounts: this is one person's UI on one machine, and the thing
 * it protects is "can you start Claude Code sessions as me". A user table would add a password
 * store, a reset flow and a session table to answer a question that only ever has one answer.
 *
 * The token arrives three ways, in this order: an `Authorization: Bearer` header for anything
 * scripted, a cookie for a browser that has been here before, and `?token=…` once — which is what
 * the link the CLI prints and the login form both use. A query token is never left in the address
 * bar: it is moved into the cookie and redirected away, because an address bar is copied into
 * chat windows and a cookie is not.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Carries the token on a browser request. HttpOnly: nothing in the page ever needs to read it. */
export const TOKEN_COOKIE = "cau_token";

/**
 * A companion cookie holding no secret, readable by the page, saying only "you are signed in".
 * It exists so the UI can offer Sign out, which it cannot work out from an HttpOnly cookie.
 */
export const HINT_COOKIE = "cau_auth";

/**
 * How long a browser keeps its copy. The token itself does not expire — it lives as long as the
 * server is configured with it — so this only decides how often a browser has to be handed it again.
 */
export const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Shortest token accepted from a user. A generated one is far longer; this is the floor for a chosen one. */
export const MIN_TOKEN_LENGTH = 8;

/** 192 bits, URL-safe, so the printed link survives a copy-paste through anything. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Parses a `Cookie` header. Unknown or malformed pairs are skipped rather than throwing. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "" || name in out) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Compares two tokens without leaking their length or a prefix match through timing.
 *
 * Digests rather than the strings themselves, because timingSafeEqual throws on a length mismatch
 * and that throw would itself be the leak: every candidate hashes to the same 32 bytes.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** The token on a request, or null — header first, then the cookie a browser already holds. */
export function presentedToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const cookie = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
  return cookie ? cookie : null;
}

/** The `?token=` on a GET, which is how the printed link and the login form hand it over. */
function queryToken(req: Request): string | null {
  const value = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof value === "string" && value !== "" ? value : null;
}

/** The same URL with `token` removed. Always a path, so it can never redirect off this server. */
function withoutToken(req: Request): string {
  const query = req.url.slice(req.path.length).replace(/^\?/, "");
  const params = new URLSearchParams(query);
  params.delete("token");
  const rest = params.toString();
  return rest ? `${req.path}?${rest}` : req.path;
}

export function setAuthCookies(res: Response, token: string): void {
  const maxAge = COOKIE_MAX_AGE_SECONDS * 1_000;
  // `lax` rather than `strict` so following a link to the UI from elsewhere does not look like a
  // logout. It is not what stops a cross-site write — the Host/Origin guard in server.ts is.
  res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge });
  res.cookie(HINT_COOKIE, "1", { httpOnly: false, sameSite: "lax", path: "/", maxAge });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(TOKEN_COOKIE, { path: "/" });
  res.clearCookie(HINT_COOKIE, { path: "/" });
}

/**
 * Gate in front of every route. `null` means authentication is off and this is a pass-through —
 * the default when the server is bound to loopback, where the OS is already the gate.
 */
export function authGuard(token: string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (token === null) return next();

    const presented = presentedToken(req);
    if (presented !== null && tokensMatch(presented, token)) return next();

    const safeMethod = req.method === "GET" || req.method === "HEAD";
    const query = safeMethod ? queryToken(req) : null;
    if (query !== null && tokensMatch(query, token)) {
      setAuthCookies(res, token);
      // 303 so the follow-up is a GET, and so the token-bearing URL is not what the history
      // entry ends up holding.
      res.redirect(303, withoutToken(req));
      return;
    }

    // A browser asking for a page gets something it can act on; anything else gets JSON it can
    // parse. The API prefix is checked first so a mistyped endpoint never answers in HTML.
    if (safeMethod && !req.path.startsWith("/api/") && req.accepts("html")) {
      res
        .status(401)
        .type("html")
        .send(loginPage({ wrong: presented !== null || query !== null }));
      return;
    }
    res.status(401).json({
      error: "authentication required: send an Authorization: Bearer header, or open the URL with ?token=…",
    });
  };
}

/** Escapes the one thing interpolated into the page below. Belt and braces: nothing user-supplied is. */
function esc(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * The sign-in page, served in place of the app for an unauthenticated browser.
 *
 * Self-contained and scriptless on purpose. It is the one page that has to work when the built
 * client is not being served — which is exactly the situation it is in, since the guard sits in
 * front of the static files — so it submits as a plain GET form and lets the guard above move the
 * token into a cookie.
 */
export function loginPage({ wrong = false }: { wrong?: boolean } = {}): string {
  const message = wrong
    ? "That token was not right. Check the link or the line the server printed when it started."
    : "This server asks for a token. It was printed in the terminal that started it.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Claude Agent UI</title>
<style>
  :root { color-scheme: light dark; --fg: #18181b; --muted: #71717a; --bg: #fafafa; --card: #fff; --line: #e4e4e7; --accent: #c15f3c; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #fafafa; --muted: #a1a1aa; --bg: #18181b; --card: #212124; --line: #333338; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem;
         background: var(--bg); color: var(--fg);
         font: 15px/1.5 "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { width: 100%; max-width: 24rem; background: var(--card); border: 1px solid var(--line);
         border-radius: 12px; padding: 1.75rem; }
  h1 { margin: 0 0 .5rem; font-size: 1.05rem; letter-spacing: -.01em; }
  p { margin: 0 0 1.25rem; color: var(--muted); font-size: .875rem; }
  p.wrong { color: var(--accent); }
  label { display: block; margin-bottom: .375rem; font-size: .8125rem; font-weight: 500; }
  input { width: 100%; padding: .5rem .625rem; border: 1px solid var(--line); border-radius: 8px;
          background: var(--bg); color: var(--fg); font: inherit;
          font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace; font-size: .875rem; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { margin-top: 1rem; width: 100%; padding: .5rem; border: 0; border-radius: 8px;
           background: var(--accent); color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
  footer { margin-top: 1.25rem; color: var(--muted); font-size: .75rem; }
</style>
</head>
<body>
<main>
  <h1>Claude Agent UI</h1>
  <p class="${wrong ? "wrong" : ""}">${esc(message)}</p>
  <form method="get" action="/">
    <label for="token">Token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autofocus required
           spellcheck="false" autocapitalize="off">
    <button type="submit">Sign in</button>
  </form>
  <footer>This browser stays signed in for 7 days.</footer>
</main>
</body>
</html>
`;
}
