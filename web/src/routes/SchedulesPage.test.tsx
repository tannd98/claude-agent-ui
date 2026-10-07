import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FireResult, Schedule } from "../lib/api.ts";
import { SchedulesPage } from "./SchedulesPage.tsx";

/**
 * What this screen owes the operator, pinned.
 *
 * The screen exists to answer "why did my 09:00 not run", and every one of these is a way that
 * answer goes missing: a slug instead of a sentence, a next-fire time on a schedule that will
 * not fire, a suppressed run-now rendered as a failure, or a limitation that only lives in the
 * README. None of them are caught by a typecheck and none of them are visible in a screenshot
 * of the happy path.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

const SCHEDULE: Schedule = {
  id: "s-1",
  name: "Nightly dependency audit",
  enabled: true,
  cron: "0 9 * * 1-5",
  timezone: "Europe/London",
  overlapPolicy: "skip",
  task: {
    agent: "dependency-audit",
    cwd: "/home/sam/code/acme-api",
    prompt: "Read the lockfile and list the advisories that reach the running app.",
    title: null,
    permissionMode: "ask",
    unattended: true,
    priority: 0,
    maxAttempts: 1,
  },
  lastFiredAt: NOW - 27 * HOUR,
  lastTrigger: "cron",
  lastTaskId: "t-91a2",
  lastSkippedAt: null,
  lastSkipReason: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: NOW - 400 * HOUR,
  updatedAt: NOW - 27 * HOUR,
  nextFireAt: NOW + 21 * HOUR,
};

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

interface Harness {
  schedules: Schedule[];
  /** What `POST /api/schedules/:id/run-now` answers. 200 either way — see FireResult. */
  runNow: FireResult;
}

function setup(initial: Partial<Harness> = {}) {
  const harness: Harness = {
    schedules: initial.schedules ?? [SCHEDULE],
    runNow: initial.runNow ?? { fired: true, taskId: "t-new" },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/schedules" && method === "GET") return json({ schedules: harness.schedules });
      if (url.endsWith("/run-now")) return json(harness.runNow);
      if (method === "PUT") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Partial<Schedule>;
        const next = { ...harness.schedules[0]!, ...patch };
        if (patch.enabled === false) next.nextFireAt = null;
        harness.schedules = [next];
        return json({ schedule: next });
      }
      if (method === "DELETE") {
        harness.schedules = [];
        return json({ ok: true });
      }
      return json({ error: `unexpected ${method} ${url}` }, 500);
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SchedulesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return harness;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SchedulesPage", () => {
  it("says the limitation out loud, above the table, without being asked", async () => {
    setup();
    // Not in a tooltip and not behind a disclosure: a user must meet this before they rely on
    // a 03:00 job, not after it failed to run.
    expect(screen.getByText(/Schedules only fire while this server is running/)).toBeVisible();
    expect(screen.getByText(/never replayed afterwards/)).toBeVisible();
  });

  it("renders the cron expression in English next to the raw expression, with its timezone", async () => {
    setup();
    await screen.findByText("Nightly dependency audit");
    expect(screen.getByText("every weekday at 09:00")).toBeVisible();
    // Next to, never instead of — the raw field is what the server validates and what is edited.
    expect(screen.getByText("0 9 * * 1-5")).toBeVisible();
    expect(screen.getByText("Europe/London")).toBeVisible();
  });

  it("falls back to the raw expression rather than inventing a sentence for a pattern it cannot read", async () => {
    // Day-of-month AND day-of-week: legal cron, ORed, and no short sentence says that honestly.
    setup({ schedules: [{ ...SCHEDULE, cron: "0 9 1 * 1" }] });
    await screen.findByText("Nightly dependency audit");
    expect(screen.getByText("A custom pattern")).toBeVisible();
    expect(screen.getByText("0 9 1 * 1")).toBeVisible();
  });

  it("shows the last skip in words, not as a slug, without expanding the row", async () => {
    setup({
      schedules: [
        {
          ...SCHEDULE,
          lastSkippedAt: NOW - HOUR,
          lastSkipReason: "previous_run_waiting",
        },
      ],
    });
    await screen.findByText("Nightly dependency audit");
    expect(screen.getByText(/Skipped: the previous run is waiting on a permission prompt/)).toBeVisible();
    expect(screen.queryByText(/previous_run_waiting/)).toBeNull();
  });

  it("shows a fire that could not be queued at all, with the server's own reason", async () => {
    setup({
      schedules: [
        {
          ...SCHEDULE,
          lastError: "no agent named dependency-audit",
          lastErrorAt: NOW - HOUR,
        },
      ],
    });
    await screen.findByText("Nightly dependency audit");
    expect(screen.getByText(/The last fire could not be queued: no agent named dependency-audit/)).toBeVisible();
  });

  it("never offers a next-fire time for a schedule that will not fire", async () => {
    setup({ schedules: [{ ...SCHEDULE, enabled: false, nextFireAt: null }] });
    await screen.findByText("Nightly dependency audit");
    // "tomorrow at 09:00" on a disabled schedule is a promise the user discovers was false at
    // 09:01. The server sends nextFireAt: null for exactly this case, and the cell must say so.
    expect(screen.getAllByText(/Disabled — will not fire/).length).toBeGreaterThan(0);
    expect(screen.getByRole("switch", { name: /Nightly dependency audit/ })).not.toBeChecked();
  });

  it("renders a suppressed run-now as the reason it is, never as a failure", async () => {
    const user = userEvent.setup();
    setup({ runNow: { fired: false, reason: "previous_run_waiting" } });
    await screen.findByText("Nightly dependency audit");

    await user.click(screen.getByRole("button", { name: /Run Nightly dependency audit once now/ }));

    // 200 with `fired: false` is the route working. An error state here would teach the
    // operator to distrust a correct answer.
    //
    // Two matches, both wanted: the row says it where the button was pressed, and the live
    // region says it for someone who is not looking at the row.
    await waitFor(() =>
      expect(screen.getAllByText(/Not queued: the previous run is waiting on a permission prompt/)).toHaveLength(2),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("links a successful run-now to the task it made, because a fire you cannot find is a no-op", async () => {
    const user = userEvent.setup();
    setup({ runNow: { fired: true, taskId: "t-new" } });
    await screen.findByText("Nightly dependency audit");

    await user.click(screen.getByRole("button", { name: /Run Nightly dependency audit once now/ }));

    await waitFor(() => expect(screen.getByText(/Queued a task now/)).toBeVisible());
    expect(screen.getByRole("link", { name: "Open it in Tasks" })).toHaveAttribute("href", "/tasks/t-new");
  });

  it("toggles the cron clock from the row and says what changed", async () => {
    const user = userEvent.setup();
    const harness = setup();
    await screen.findByText("Nightly dependency audit");

    const toggle = screen.getByRole("switch", { name: /Nightly dependency audit/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => expect(harness.schedules[0]!.enabled).toBe(false));
    const live = screen.getByRole("status", { name: "" });
    await waitFor(() => expect(live).toHaveTextContent(/is off\. The cron clock will not fire it\./));
  });

  it("confirms before deleting, and says what survives the delete", async () => {
    const user = userEvent.setup();
    const harness = setup();
    await screen.findByText("Nightly dependency audit");

    await user.click(screen.getByRole("button", { name: /Delete Nightly dependency audit/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Tasks it has already queued are not affected/)).toBeVisible();

    // Nothing has happened yet — the confirmation is a real gate, not a formality.
    expect(harness.schedules).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(harness.schedules).toHaveLength(0));
  });

  it("teaches rather than showing blank space when there is nothing scheduled", async () => {
    setup({ schedules: [] });
    expect(await screen.findByText("No schedules yet")).toBeVisible();
    expect(screen.getByText(/it adds a task to the queue/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /New schedule/ }).length).toBeGreaterThan(0);
  });
});
