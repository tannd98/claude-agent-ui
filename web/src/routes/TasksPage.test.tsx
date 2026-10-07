import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "../lib/api.ts";
import { queryKeys } from "../lib/api.ts";
import { TasksPage } from "./TasksPage.tsx";

/**
 * Who wins the live region.
 *
 * Two writers share it: a mutation's reply, which knows *why* something happened, and the
 * differ, which only sees a badge label change. The same mutation that writes the first also
 * invalidates the list, so the differ's thinner sentence lands ~50ms behind — inside the pause
 * before a polite region is ever spoken. `taskStatus.test.ts` pins what `cancelOutcome` says;
 * what is pinned here is whether it survives long enough to be said.
 *
 * Asserted on the region's *final* text rather than on a sequence: that is what a screen
 * reader actually announces, and it is the only part a user experiences.
 */

const RUNNING: TaskView = {
  id: "t-1",
  title: "Draft release notes for 0.4.0",
  agent: "release-notes",
  cwd: "/home/sam/code/acme-web",
  prompt: "Summarise what changed since 0.3.2.",
  permissionMode: "ask",
  unattended: true,
  priority: 0,
  state: "running",
  attempts: 1,
  maxAttempts: 1,
  runId: "r-1",
  sessionId: "s-1",
  scheduleId: null,
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_001_000,
  finishedAt: null,
  result: null,
  error: null,
  queuePosition: null,
  waiting: null,
  attachCommand: "claude attach r-1",
};

const OTHER: TaskView = {
  ...RUNNING,
  id: "t-2",
  title: "Upgrade the test runner to v4",
  runId: "r-2",
  sessionId: "s-2",
  attachCommand: "claude attach r-2",
};

/** What `POST /api/tasks` answers, and the row the list carries a moment later. */
const CREATED: TaskView = {
  ...RUNNING,
  id: "t-3",
  title: "Prune stale preview deployments",
  agent: "housekeeping",
  prompt: "Delete preview environments with no commits in 30 days.",
  state: "queued",
  attempts: 0,
  runId: null,
  sessionId: null,
  startedAt: null,
  queuePosition: 1,
  attachCommand: null,
};

const started = (task: TaskView): TaskView => ({
  ...task,
  state: "running",
  attempts: 1,
  runId: "r-3",
  sessionId: "s-3",
  startedAt: 1_700_000_003_000,
  queuePosition: null,
  attachCommand: "claude attach r-3",
});

const settled = (task: TaskView, state: TaskView["state"]): TaskView => ({
  ...task,
  state,
  finishedAt: 1_700_000_002_000,
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

interface Harness {
  /** What `GET /api/tasks` answers next. Reassign to stand in for an SSE-driven refetch. */
  tasks: TaskView[];
  /** What `POST /api/tasks/:id/cancel` answers — the row the server actually settled on. */
  cancelReply: TaskView;
}

const AGENT = {
  id: "housekeeping",
  name: "Housekeeping",
  runName: "housekeeping",
  description: "Tidies up after preview builds.",
  model: null,
  scope: "project",
  plugin: null,
  editable: true,
  readOnlyReason: null,
  parses: true,
  valid: true,
  error: null,
};

function setup(initial: Partial<Harness> = {}) {
  const harness: Harness = {
    tasks: initial.tasks ?? [RUNNING, OTHER],
    cancelReply: initial.cancelReply ?? settled(RUNNING, "cancelled"),
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tasks/stats") return json({ queued: 0, running: 1, waiting: 0, maxConcurrent: 2 });
      if (url === "/api/tasks" && init?.method === "POST") return json(CREATED);
      if (url === "/api/tasks") return json({ tasks: harness.tasks, warning: null });
      if (url === "/api/agents") return json([AGENT]);
      if (url === "/api/config")
        return json({
          defaultCwd: "/home/sam/code/acme-web",
          starterPrompt: "",
          permissionMode: "ask",
          templates: { agent: "", skill: "" },
        });
      if (url.endsWith("/cancel") && init?.method === "POST") return json(harness.cancelReply);
      throw new Error(`unexpected request: ${url}`);
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    harness,
    user: userEvent.setup(),
    /**
     * Stands in for an SSE `task:updated`: swap the server's answer, then invalidate.
     *
     * The second `act` is load-bearing, not belt-and-braces. The differ writes a render behind
     * the row it reacts to — the refetch renders, *then* its effect queues the announcement —
     * so an assertion made the moment the new badge appears reads a live region React has not
     * finished with, and "the differ did not overwrite" passes against either behaviour.
     * Turning the loop once more is what makes a negative assertion here mean anything.
     */
    async push(tasks: TaskView[]) {
      harness.tasks = tasks;
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.tasks });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

/** The live region is `role="status"`; the staleness bar shares the role, so find it by position. */
const region = () => screen.getAllByRole("status")[0]!;

async function cancelFromRow(user: ReturnType<typeof userEvent.setup>, task: TaskView) {
  await user.click(await screen.findByRole("button", { name: `Cancel ${task.title}` }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel task" }));
}

beforeEach(() => {
  // The lost-race path highlights the row, which scrolls it into view. jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("TasksPage — the live region's last word", () => {
  it("keeps the reason when a task settles before the cancel lands", async () => {
    const { user, push } = setup({ cancelReply: settled(RUNNING, "succeeded") });
    await screen.findByText(RUNNING.title);

    await cancelFromRow(user, RUNNING);
    await waitFor(() =>
      expect(region()).toHaveTextContent('"Draft release notes for 0.4.0" finished before it could be stopped'),
    );
    // The refetch the mutation itself triggered now lands, carrying the same change as a bare
    // label flip. It must not flatten the sentence that explains it.
    await push([settled(RUNNING, "succeeded"), OTHER]);

    // getAllByText, because the badge is rendered twice: once in the status column and once
    // stacked above the title for below-`md`. CSS displays exactly one, but jsdom does not
    // resolve the media query, so both are in the tree here.
    await waitFor(() => expect(screen.getAllByText("Succeeded")[0]).toBeInTheDocument());
    expect(region()).toHaveTextContent(
      '"Draft release notes for 0.4.0" finished before it could be stopped — Succeeded.',
    );
    expect(region()).not.toHaveTextContent("Draft release notes for 0.4.0: Succeeded.");
  });

  it("keeps the plain wording of an ordinary cancel", async () => {
    const { user, push } = setup({ cancelReply: settled(RUNNING, "cancelled") });
    await screen.findByText(RUNNING.title);

    await cancelFromRow(user, RUNNING);
    await push([settled(RUNNING, "cancelled"), OTHER]);

    // Two copies, one per breakpoint — see the note in the test above.
    await waitFor(() => expect(screen.getAllByText("Cancelled")[0]).toBeInTheDocument());
    expect(region()).toHaveTextContent('Cancelled "Draft release notes for 0.4.0".');
  });

  it("still announces a task the user did not act on", async () => {
    const { user, push } = setup({ cancelReply: settled(RUNNING, "succeeded") });
    await screen.findByText(RUNNING.title);

    await cancelFromRow(user, RUNNING);
    await waitFor(() => expect(region()).toHaveTextContent("finished before it could be stopped"));
    // Silence here would be the worse bug: nothing else on screen says this one moved.
    await push([RUNNING, settled(OTHER, "failed")]);

    await waitFor(() => expect(region()).toHaveTextContent("Upgrade the test runner to v4: Failed."));
  });

  it("still announces a multi-task change that includes the acted-on task", async () => {
    const { user, push } = setup({ cancelReply: settled(RUNNING, "succeeded") });
    await screen.findByText(RUNNING.title);

    await cancelFromRow(user, RUNNING);
    await waitFor(() => expect(region()).toHaveTextContent("finished before it could be stopped"));
    await push([settled(RUNNING, "succeeded"), settled(OTHER, "failed")]);

    await waitFor(() => expect(region()).toHaveTextContent("2 tasks changed state."));
  });

  it("lets a new task's start of run speak, moments after it was queued", async () => {
    // Creation is the one action with no competing retelling to outrank: the differ reports
    // labels that *changed*, and a task appearing changed nothing. So the next thing it says
    // about this task is a different event — on a free slot, this one starting a second later —
    // and the queued sentence has no business silencing it.
    const { user, push } = setup({ tasks: [OTHER] });
    await screen.findByText(OTHER.title);

    await user.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Agent"), AGENT.id);
    await user.type(within(dialog).getByLabelText("Prompt"), CREATED.prompt);
    await user.click(within(dialog).getByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(region()).toHaveTextContent('Queued "Prune stale preview deployments".'));
    // `task:created`, then `task:updated` a moment later — both well inside the four seconds a
    // cancel or a retry would have held the region for.
    await push([OTHER, CREATED]);
    await push([OTHER, started(CREATED)]);

    await waitFor(() => expect(region()).toHaveTextContent("Prune stale preview deployments: Running."));
  });

  it("announces a later change to the same task once the action's window has passed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user, push } = setup({ cancelReply: settled(RUNNING, "succeeded") });
      await screen.findByText(RUNNING.title);

      await cancelFromRow(user, RUNNING);
      await waitFor(() => expect(region()).toHaveTextContent("finished before it could be stopped"));
      await vi.advanceTimersByTimeAsync(5_000);
      await push([settled(RUNNING, "failed"), OTHER]);

      await waitFor(() => expect(region()).toHaveTextContent("Draft release notes for 0.4.0: Failed."));
    } finally {
      vi.useRealTimers();
    }
  });
});
