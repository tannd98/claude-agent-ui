import type { Status } from "../components/StatusBadge.tsx";
import type { TaskView } from "./api.ts";
import { ordinal, relativeTime } from "./utils.ts";

/**
 * Eight conditions, one mapping.
 *
 * Six of them are `state` alone; two are `state: "running"` split by `waiting.reason`, because
 * `waiting` is deliberately not a seventh state on the wire — a waiting task is running and
 * holds its concurrency slot. The split lives here so the table, the detail pane and the status
 * bar cannot drift apart about what a task is called.
 *
 * Hue decisions behind the table (ui-ux-pro-max ux-guidelines No. 37 — never colour alone):
 *
 *   - **Amber means "a human is needed here", and only that.** `waiting` (both reasons) and
 *     `blocked` share it. Three conditions, one meaning, one hue.
 *   - **Queued is blue, not amber.** A queued task needs nothing from anybody; at concurrency 2
 *     a backlog is the normal majority, and amber rows would drown the one task parked on a
 *     permission prompt.
 *   - **Succeeded is slate, not green.** Green is the accent and it means *live*. A finished
 *     queue glowing green would stop "what is running right now" being findable at a glance.
 */
export interface TaskBadge {
  status: Status;
  label: string;
  /** Hover detail. Undefined rather than empty — the CLI can report a wait with no reason. */
  title?: string;
}

export function taskBadge(task: TaskView): TaskBadge {
  switch (task.state) {
    case "queued":
      return { status: "queued", label: "Queued" };
    case "running":
      if (!task.waiting) return { status: "running", label: "Running" };
      return task.waiting.reason === "permission"
        ? {
            status: "waiting",
            label: "Needs permission",
            title: "The agent asked to use a tool and is waiting for an answer.",
          }
        : // The CLI's own word for the wait, verbatim. We do not synthesise one, so an
          // unnamed wait gets the soft label and no detail.
          { status: "waiting", label: "Waiting — may need input", title: task.waiting.detail || undefined };
    case "succeeded":
      return { status: "finished", label: "Succeeded" };
    case "failed":
      return { status: "failed", label: "Failed", title: task.error ?? undefined };
    case "blocked":
      return { status: "blocked", label: "Blocked" };
    case "cancelled":
      return { status: "cancelled", label: "Cancelled" };
    default: {
      // A state the server grew and this client has not learnt yet. Never a silent blank.
      const unreachable: never = task.state;
      return { status: "unknown", label: String(unreachable) };
    }
  }
}

/**
 * What to say once a cancel has come back.
 *
 * `POST /api/tasks/:id/cancel` answers with the task's *actual* state, not with `cancelled`: a
 * running task can settle while `claude stop` is in flight, and the first terminal write wins
 * (tasks-api-contract rev 4), so a `200` can carry `succeeded`, `failed` or `blocked`. Every
 * rendered row already re-reads from the server, which leaves this sentence as the only thing
 * on screen that could still be claiming an outcome the task never reached.
 *
 * Two forms, because there are two width budgets. The table's live region is page-level and the
 * row has moved by the time it reads, so it needs the title; the detail pane is already headed
 * by the title and only has room for the fact.
 */
export function cancelOutcome(settled: TaskView, title?: string): string {
  if (settled.state === "cancelled") return title === undefined ? "Cancelled." : `Cancelled "${title}".`;
  const what = `finished before it could be stopped — ${taskBadge(settled).label}.`;
  return title === undefined ? `It ${what}` : `"${title}" ${what}`;
}

/**
 * The badge's second channel: the short fact that state implies, sitting under the badge.
 *
 * Status is never only a hue and never only a word either — a queued row that cannot say how
 * far down the queue it is has told the operator nothing they came to find out.
 *
 * Deliberately short. It shares a fixed-width column with the badge, so anything that needs a
 * sentence belongs in {@link taskReason} instead, which has the width for it.
 */
export function taskTiming(task: TaskView, queuedTotal: number, now = Date.now()): string | null {
  switch (task.state) {
    case "queued":
      return task.queuePosition === null ? null : `${ordinal(task.queuePosition)} of ${queuedTotal}`;
    case "running":
      if (task.waiting) return `waiting ${relativeTime(task.waiting.since, now)}`;
      return task.startedAt === null ? null : `started ${relativeTime(task.startedAt, now)}`;
    case "succeeded":
    case "cancelled":
    case "failed":
    case "blocked":
      return duration(task.startedAt, task.finishedAt);
    default:
      return null;
  }
}

/**
 * The one line that says *why*, for the two states that owe the operator one.
 *
 * It rides under the title rather than under the badge because that is where the width is — a
 * cause truncated to four words is the same dead end as no cause at all.
 */
export function taskReason(task: TaskView): string | null {
  if (task.state === "failed") return firstLine(task.error);
  if (task.state === "blocked") return firstLine(task.result);
  // Only for the soft wait. For a permission prompt the label already says the whole thing, and
  // echoing the CLI's "permission prompt" under it is the same sentence twice.
  if (task.state === "running" && task.waiting?.reason === "other") return task.waiting.detail || null;
  return null;
}

/**
 * The tail of a path, for a column too narrow for the whole thing.
 *
 * Done in JS rather than with `dir="rtl"`: that CSS trick truncates from the correct end but
 * reorders the bidirectional run, so `/Users/sam/code/acme-web` renders as `…ode/acme-web/`
 * with the leading slash moved to the tail. The full path stays in the cell's `title`.
 */
export function pathTail(cwd: string, segments = 2): string {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= segments) return cwd;
  return `…/${parts.slice(-segments).join("/")}`;
}

/** How long it ran, in the coarsest unit that is still true. `null` when it never started. */
export function duration(startedAt: number | null, finishedAt: number | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `ran ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `ran ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `ran ${hours}h ${minutes % 60}m`;
}

function firstLine(text: string | null): string | null {
  const line = text?.split("\n").find((l) => l.trim());
  return line?.trim() ?? null;
}

/** Which group of the table a task belongs to. The server already returns them in this order. */
export type TaskGroup = "running" | "queued" | "history";

export function taskGroup(task: TaskView): TaskGroup {
  if (task.state === "running") return "running";
  if (task.state === "queued") return "queued";
  return "history";
}

/**
 * Priority as three named levels rather than a number field.
 *
 * The server keeps `priority` a plain int and knows nothing about these; the mapping is purely
 * a recognition-over-recall choice on this side, with headroom left on both ends in case a
 * numeric control ever appears.
 */
export const PRIORITY_LEVELS = [
  { value: 1, label: "High" },
  { value: 0, label: "Normal" },
  { value: -1, label: "Low" },
] as const;

export function priorityLabel(priority: number): string {
  if (priority > 0) return "High";
  if (priority < 0) return "Low";
  return "Normal";
}
