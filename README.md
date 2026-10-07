# claude-agent-ui

A local web UI to browse, edit, schedule and run your Claude Code agents as background sessions.

![Queueing a task, the permission choice, schedules and the agent editor](docs/demo.gif)

## Quickstart

You need Node 20+ and the Claude Code CLI on your `PATH` as `claude`.

```sh
npx claude-agent-ui
```

That is the whole setup. It prints a URL, opens <http://127.0.0.1:3000> in your browser, and
creates `~/.claude-agent-ui/` the first time it runs. There is no config file to write, no account,
and nothing to sign in to.

What you get:

- **Agents** — every agent definition on disk, project and user scope and plugins, edited in place.
- **Skills** — the same, for skills, and which agents can reach them.
- **Tasks** — a real work queue. Two run at once by default; the rest wait their turn.
- **Schedule** — cron entries that add a task to that queue.

Press Ctrl-C to stop it. Nothing is left running.

## Security

This runs agents on your machine with your files. Three things are worth knowing before you do.

### Permission mode: `ask` by default

Every task carries a `permissionMode`, and it starts at **`ask`**.

| Mode                | What it does                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ask` (default)     | The CLI prompts for each tool it wants to use. The task parks on the prompt and keeps its queue slot until you answer. |
| `bypassPermissions` | Passes `--dangerously-skip-permissions` to the CLI.                                                                    |

`--dangerously-skip-permissions` means exactly what it says: the agent runs every tool it decides
to run — writing files, deleting them, `git push`, `curl`, installing packages — without asking you
first, anywhere it can reach from its working directory. Nobody is watching a background session,
so there is no moment where you get to say no.

It is a **per-task opt-in**. Choosing it names the directory the task will run in and asks you to
confirm — every time, with no "don't ask again".

`--permission-mode bypassPermissions` on the command line moves the default for an _immediate_ run
only. **Queued and scheduled tasks never inherit it**: they start from `ask` whatever the flag says,
because a queued task is by definition one nobody is sitting in front of. There is no setting
anywhere that turns bypass on for everything at once.

A task in `ask` mode that nobody answers will sit there. That is the trade, and it is the reason the
Schedule screen tells you when a firing was skipped because the previous run is still waiting.

### Loopback only

The server binds `127.0.0.1` and **there is no flag to change it** — `--host` is rejected with an
error rather than quietly ignored. Every route is additionally behind a guard that checks `Host`
and `Origin`, so a web page you happen to have open cannot drive it by resolving its own hostname
to `127.0.0.1`.

If you need it from another machine, forward a port over SSH:

```sh
ssh -L 3000:127.0.0.1:3000 you@that-machine
```

That keeps the authentication and the encryption in SSH, where they belong, instead of in an app
that has none of either.

### No telemetry

Nothing is collected and nothing is sent anywhere. No analytics, no crash reporting, no update
check, no "anonymous usage statistics". The only processes it starts are your `claude` binary and,
once at startup unless you pass `--no-open`, your browser. The only network listener is the loopback
one above.

Your state is yours too: `~/.claude-agent-ui/` is plain JSON, written atomically, and you can read,
back up or delete it with ordinary tools.

## Running it in the background

**Schedules only fire while the server is running.** Cron runs in-process — there is no daemon
watching for you. Close the terminal and a 3am schedule does not fire, and it is not replayed when
you start up again.

If you want schedules to fire whether or not the UI is open, run the server as a user service.

Install it properly first, so there is a stable path to point at:

```sh
npm install -g claude-agent-ui
command -v claude-agent-ui    # the path the service will run
```

Two details decide whether this works:

- **`PATH`.** launchd and systemd both hand a service a minimal `PATH` that does not include
  nvm, Homebrew or `~/.local/bin`. If `claude` is not on it, the server refuses to start and says
  so. Set it explicitly to whatever `echo $PATH` shows in your own shell.
- **One server at a time.** The service holds a lock on the data directory. With it running,
  `npx claude-agent-ui` will exit and tell you which PID has it — that is correct, not a fault.
  Just open <http://127.0.0.1:3000>.

### macOS — launchd

`~/Library/LaunchAgents/com.claude-agent-ui.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-agent-ui</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/claude-agent-ui</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/claude-agent-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claude-agent-ui.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-agent-ui.plist
launchctl print gui/$(id -u)/com.claude-agent-ui   # state, and the last exit code
tail -f /tmp/claude-agent-ui.log                   # the URL, and any preflight complaint

launchctl bootout gui/$(id -u)/com.claude-agent-ui # stop and unload
```

A LaunchAgent runs when you are logged in. It is deliberately not a LaunchDaemon: a daemon runs as
root before login, and nothing here should hold root or read another user's `~/.claude`.

### Linux — systemd

`~/.config/systemd/user/claude-agent-ui.service`:

```ini
[Unit]
Description=Claude Agent UI
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/claude-agent-ui --no-open
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now claude-agent-ui
systemctl --user status claude-agent-ui
journalctl --user -u claude-agent-ui -f

# Keep it running when you are not logged in — without this, your user units stop at logout.
sudo loginctl enable-linger "$USER"
```

A **user** unit, not a system one, for the same reason: it needs your `~/.claude` and should have
nothing more than your own privileges.

### Schedules that have to finish on their own

A scheduled task in `ask` mode will park on the first permission prompt and wait for you. If the
point is that you are asleep, the task has to be `bypassPermissions` — and that is the dangerous
mode described above. Decide that per schedule, against the directory it runs in. There is no
setting that makes it both unattended and safe.

## Options

```
--port <n>              Port to listen on, 0 picks a free one (default 3000)
--data-dir <path>       State directory (default ~/.claude-agent-ui)
--config <path>         Config file (default <data-dir>/config.json)
--cwd <path>            Default working directory for new runs
--claude-bin <path>     Path to the claude binary
--starter-prompt <text> Prompt used when a run is started with no prompt
--concurrency <n>       Tasks run at once (default 2)
--max-attempts <n>      Attempts per task, 1 = retries off (default 1)
--history-limit <n>     Stored history entries (default 500)
--permission-mode <m>   "ask" (default) or "bypassPermissions"
--no-open               Do not open the UI in your browser (it opens by default)
-h, --help              Show this help
-v, --version           Show the version
```

Every option can also be set in `~/.claude-agent-ui/config.json` or through a
`CLAUDE_AGENT_UI_*` environment variable. Flags beat environment variables, which beat the
config file.

## Other defaults worth knowing

- **Retries are off.** A failed task stays failed (`--max-attempts 1`). Re-running an agent that
  half-finished something is rarely free, so it is your call, from the Retry button.
- **History is capped at 500.** The oldest entries are dropped. `--history-limit` moves the cap.
- **Nothing polls.** The UI gets one `GET /api/events` server-sent-event stream and re-reads what
  changed. It reconnects with `Last-Event-ID`, and a client that stops reading is dropped rather
  than buffered.
- **Untested CLI versions warn, once, at startup.** This release is built against Claude Code 2.x.
  A different major still starts — it just says so first, on stderr.

## Development

The server and the React client are separate npm projects, so both need installing.

```sh
npm install
npm run web:install

npm test           # server, node:test — no claude binary required
npm run web:test   # client, vitest
npm run typecheck
npm run build      # tsup → dist/, then vite → dist/web, in that order
npm start          # runs the CLI from source
npm run dev        # same, restarting on a change
npm run web:dev    # the client with HMR, proxying /api to the server above
```

`npm run test:smoke` is the one that matters before a release: it packs the tarball, installs it
into an empty directory and walks all four screens in a real browser, so it catches what a test
importing from `src/` cannot. It needs a browser — `npx playwright install chromium`, or it
falls back to an installed Google Chrome.

The build order is not interchangeable. `tsup` cleans `dist/` first; running `vite` before it
would delete the client that was just built.

`web/scripts/` holds the dev tools: `check:a11y` for the accessibility audit, `check:contrast`
for the token pairs, and `shoot-demo.mjs` for the GIF above. The browser-driving ones run against
`web/scripts/mock-api.mjs`, which speaks the same wire format as the real server with entirely
synthetic content. None of them ship.

`check:a11y` drives the running client, so start the dev server first and leave port 3000 free —
the audit starts and restarts its own mock API there, because it checks the empty and error
screens, and `mock-api.mjs` fixes its scenario at launch:

```sh
npm run web:dev &                     # vite on 127.0.0.1:5174
npm --prefix web run check:a11y       # starts its own mock-api.mjs on :3000
```

`check:contrast` parses `src/styles/tokens.css` directly and needs nothing running.

### Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes with
`--provenance --access public --tag latest`. Nobody publishes from a laptop, and not only as a
policy: npm can mint a provenance attestation **only** from GitHub Actions or GitLab CI, where it
can attest which commit and which workflow built the tarball. Run by hand, `npm publish
--provenance` fails with `Automatic provenance generation not supported for provider: <none>`.

The workflow refuses to publish if the tag disagrees with `package.json`, or if `repository` is
missing or names a different repo — provenance binds the tarball to a source repository, so that
field has to be right before the first release.

## Licence

MIT
