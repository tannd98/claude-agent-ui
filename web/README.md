# web/

The React client. Vite builds it into `../dist/web/`, which `src/server.ts` serves as static
files (`AppOptions.webRoot`).

It is a **separate npm package** on purpose: React, Vite and Tailwind are build-time only, and
keeping them here means the published `claude-agent-ui` package ships the built bundle without
inheriting any of them as runtime dependencies.

## Running it

```bash
npm --prefix web install     # once
npm run dev                  # the API server, on 127.0.0.1:3000
npm --prefix web run dev     # the client, on 127.0.0.1:5174, /api proxied to the server
```

Both servers bind `127.0.0.1` and nothing else. The Vite config pins `host: "127.0.0.1"`;
do not add `--host`.

With no API server running, every screen renders its error state — which is correct, and is
also how to look at that state on purpose. `scripts/mock-api.mjs` is the other way:

```bash
node scripts/mock-api.mjs --scenario populated   # or: empty, error
curl -X POST http://127.0.0.1:3000/__mock/start-run   # pushes a run:started over SSE
```

It speaks the same wire format as the real server, with synthetic content.

## Checks

```bash
npm --prefix web run typecheck        # tsc --noEmit
npm --prefix web test                 # vitest
npm --prefix web run check:contrast   # WCAG AA over the token layer, both themes
node web/scripts/shoot.mjs ./shots    # renders the shell at 1440x900 and 390x844
```

`shoot.mjs` needs both servers up and uses the locally installed Google Chrome.

## How it is put together

| Path                          | What lives there                                                           |
| ----------------------------- | -------------------------------------------------------------------------- |
| `src/styles/tokens.css`       | The three-layer token set. Read the header comment before adding a colour. |
| `src/styles/index.css`        | Tailwind entry, self-hosted fonts, global focus and reduced-motion rules.  |
| `src/lib/eventStream.ts`      | The single SSE connection and its backoff.                                 |
| `src/hooks/useEventStream.ts` | Maps server events onto React Query cache invalidations.                   |
| `src/components/`             | Shell (sidebar, status bar) and the shared primitives.                     |
| `src/components/ui/`          | shadcn-style primitives: Radix + cva + `cn`.                               |
| `src/routes/`                 | One file per area.                                                         |

Two rules that are enforced, not just asked for:

- **No raw colour values outside `tokens.css`.** `src/styles/tokens.test.ts` fails the build on
  a hex or `rgb()` in a component. If the token you need is missing, add it to the right layer.
- **No polling and no remote assets.** React Query's defaults disable every refetch timer; the
  SSE stream is the only thing that invalidates a cache. The same test fails on any `https://`
  reference in the source, which is how the self-hosted fonts stay self-hosted.
