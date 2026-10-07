import { describe, expect, it } from "vitest";
import type { TaskView } from "./api.ts";
import { cancelOutcome, duration, pathTail, taskBadge, taskGroup, taskReason, taskTiming } from "./taskStatus.ts";

const BASE: TaskView = {
  id: "t-1",
  title: "Draft the release notes",
  agent: "release-notes",
  cwd: "/home/sam/code/acme-web",
  prompt: "Summarise what changed.",
  permissionMode: "ask",
  unattended: true,
  priority: 0,
  state: "queued",
  attempts: 1,
  maxAttempts: 1,
  runId: null,
  sessionId: null,
  scheduleId: null,
  createdAt: 1_000,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  waiting: null,
  queuePosition: null,
  attachCommand: null,
};

const task = (over: Partial<TaskView>): TaskView => ({ ...BASE, ...over });

describe("cancelOutcome", () => {
  it("says cancelled only when the server says cancelled", () => {
    expect(cancelOutcome(task({ state: "cancelled" }), "Draft the release notes")).toBe(
      'Cancelled "Draft the release notes".',
    );
    expect(cancelOutcome(task({ state: "cancelled" }))).toBe("Cancelled.");
  });

  // tasks-api-contract rev 4: a task that settles while `claude stop` is in flight answers 200
  // with the outcome it actually reached. Announcing "Cancelled" there is the one lie the
  // screen could still tell, since every rendered row re-reads from the server.
  it("names the real outcome when the cancel lost the race", () => {
    for (const [state, word] of [
      ["succeeded", "Succeeded"],
      ["failed", "Failed"],
      ["blocked", "Blocked"],
    ] as const) {
      const message = cancelOutcome(task({ state }), "Draft the release notes");
      expect(message).toBe(`"Draft the release notes" finished before it could be stopped — ${word}.`);
      expect(message).not.toMatch(/Cancelled/);
      // The titleless form is for the detail pane, which is already headed by the title.
      expect(cancelOutcome(task({ state }))).toBe(`It finished before it could be stopped — ${word}.`);
    }
  });
});

describe("taskBadge", () => {
  it("covers all eight conditions, each with a word of its own", () => {
    const cases: [TaskView, string, string][] = [
      [task({ state: "queued" }), "queued", "Queued"],
      [task({ state: "running" }), "running", "Running"],
      [
        task({ state: "running", waiting: { reason: "permission", detail: "permission prompt", since: 5 } }),
        "waiting",
        "Needs permission",
      ],
      [
        task({ state: "running", waiting: { reason: "other", detail: "input needed", since: 5 } }),
        "waiting",
        "Waiting — may need input",
      ],
      [task({ state: "succeeded" }), "finished", "Succeeded"],
      [task({ state: "failed", error: "the CLI reported that the session failed" }), "failed", "Failed"],
      [task({ state: "blocked", result: "No vault token." }), "blocked", "Blocked"],
      [task({ state: "cancelled" }), "cancelled", "Cancelled"],
    ];

    for (const [input, status, label] of cases) {
      expect(taskBadge(input)).toMatchObject({ status, label });
    }
    // Eight conditions, eight distinct words: no two states read the same.
    expect(new Set(cases.map(([input]) => taskBadge(input).label)).size).toBe(8);
  });

  it("keeps waiting out of the terminal hues", () => {
    const waiting = taskBadge(task({ state: "running", waiting: { reason: "permission", detail: "", since: 1 } }));
    expect(waiting.status).toBe("waiting");
    expect(waiting.status).not.toBe("failed");
    expect(waiting.status).not.toBe("finished");
  });

  it("never carries an empty hover string when the CLI named no reason", () => {
    const badge = taskBadge(task({ state: "running", waiting: { reason: "other", detail: "", since: 1 } }));
    expect(badge.label).toBe("Waiting — may need input");
    expect(badge.title).toBeUndefined();
  });
});

describe("taskTiming", () => {
  it("gives a queued task its place in the queue", () => {
    expect(taskTiming(task({ state: "queued", queuePosition: 3 }), 7)).toBe("3rd of 7");
  });

  it("times a running task from when it started, and a waiting one from when it parked", () => {
    const now = 1_000_000;
    expect(taskTiming(task({ state: "running", startedAt: now - 120_000 }), 0, now)).toMatch(/^started /);
    expect(
      taskTiming(
        task({
          state: "running",
          startedAt: now - 600_000,
          waiting: { reason: "permission", detail: "", since: now - 120_000 },
        }),
        0,
        now,
      ),
    ).toMatch(/^waiting /);
  });

  it("stays short enough for the status column", () => {
    const finished = task({ state: "succeeded", startedAt: 0, finishedAt: 840_000 });
    expect(taskTiming(finished, 0)).toBe("ran 14m");
  });
});

describe("taskReason", () => {
  it("leads a failed task with its cause", () => {
    expect(taskReason(task({ state: "failed", error: "the background session stopped\nmore detail" }))).toBe(
      "the background session stopped",
    );
  });

  it("uses the already-stripped result for a blocked task", () => {
    // The server removed the BLOCKED: sentinel; the client must not know it exists.
    expect(taskReason(task({ state: "blocked", result: "No vault token in this environment." }))).toBe(
      "No vault token in this environment.",
    );
  });

  it("does not echo the CLI's wording under a label that already says it", () => {
    expect(
      taskReason(task({ state: "running", waiting: { reason: "permission", detail: "permission prompt", since: 1 } })),
    ).toBeNull();
    expect(taskReason(task({ state: "running", waiting: { reason: "other", detail: "dialog open", since: 1 } }))).toBe(
      "dialog open",
    );
  });

  it("renders nothing rather than a stand-in when the wait has no named reason", () => {
    expect(taskReason(task({ state: "running", waiting: { reason: "other", detail: "", since: 1 } }))).toBeNull();
  });
});

describe("taskGroup", () => {
  it("puts every terminal state in history and nothing else", () => {
    expect(taskGroup(task({ state: "running" }))).toBe("running");
    expect(taskGroup(task({ state: "queued" }))).toBe("queued");
    for (const state of ["succeeded", "failed", "blocked", "cancelled"] as const) {
      expect(taskGroup(task({ state }))).toBe("history");
    }
  });

  it("keeps a waiting task in the running group, because it still holds its slot", () => {
    expect(taskGroup(task({ state: "running", waiting: { reason: "permission", detail: "", since: 1 } }))).toBe(
      "running",
    );
  });
});

describe("duration", () => {
  it("uses the coarsest unit that is still true", () => {
    expect(duration(0, 30_000)).toBe("ran 30s");
    expect(duration(0, 14 * 60_000)).toBe("ran 14m");
    expect(duration(0, 95 * 60_000)).toBe("ran 1h 35m");
  });

  it("says nothing about a task that never started", () => {
    expect(duration(null, 5)).toBeNull();
    expect(duration(5, null)).toBeNull();
  });
});

describe("pathTail", () => {
  it("keeps the part that identifies the directory, in reading order", () => {
    // The dir="rtl" alternative renders this as "…ode/acme-web/" — correct end, wrong order.
    expect(pathTail("/home/sam/code/acme-web")).toBe("…/code/acme-web");
  });

  it("leaves a short path alone", () => {
    expect(pathTail("/tmp")).toBe("/tmp");
    expect(pathTail("/home/sam")).toBe("/home/sam");
  });
});
