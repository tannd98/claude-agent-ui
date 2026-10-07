import type { Status } from "../components/StatusBadge.tsx";
import type { Schedule, SkipReason } from "./api.ts";

/**
 * What a schedule row says about itself.
 *
 * The screen this feeds exists to answer one question — *why did my 09:00 not run* — and that
 * answer only exists because the server records every suppression and every failed fire on the
 * schedule itself. Turning those into sentences is this file's whole job: a slug like
 * `previous_run_waiting` on screen is the same dead end as no answer at all.
 */

export interface ScheduleBadge {
  status: Status;
  label: string;
  title?: string;
}

/**
 * Enabled or not, as a badge.
 *
 * Two conditions only. A schedule has no state of its own beyond "the clock is armed" — the
 * *work* it makes lives in the queue, and conflating the two would make this screen a second,
 * worse Tasks page.
 */
export function scheduleBadge(schedule: Schedule): ScheduleBadge {
  return schedule.enabled
    ? { status: "scheduled", label: "On", title: "The cron clock is armed for this schedule." }
    : {
        status: "idle",
        label: "Off",
        title: "The cron clock is not armed. Run once now still works on a disabled schedule.",
      };
}

/** Why a fire was suppressed, as the end of the sentence "skipped: …". */
export function skipReasonText(reason: SkipReason): string {
  switch (reason) {
    case "previous_run_waiting":
      // The one the CEO rule exists for, and the one that reads worst as a slug. It is also the
      // only reason that applies under `queue` as well as `skip`, so it says what to do next.
      return "the previous run is waiting on a permission prompt. Answer it and the next fire goes ahead.";
    case "previous_task_running":
      return "the previous task was still running.";
    case "previous_task_queued":
      return "the previous task was still queued.";
    default: {
      const unreachable: never = reason;
      return String(unreachable);
    }
  }
}

/**
 * The most recent thing that happened to this schedule, whatever kind of thing it was.
 *
 * A row that shows only `lastFiredAt` is telling a half-truth the moment a fire is suppressed:
 * "last fired 3 days ago" with no mention of the four skips since reads as a dead schedule
 * rather than a blocked one. So the three timestamps compete and the newest wins.
 */
export type ScheduleOutcome =
  | { kind: "fired"; at: number; taskId: string | null; trigger: Schedule["lastTrigger"] }
  | { kind: "skipped"; at: number; reason: SkipReason }
  | { kind: "failed"; at: number; error: string };

export function lastOutcome(schedule: Schedule): ScheduleOutcome | null {
  const candidates: ScheduleOutcome[] = [];
  if (schedule.lastFiredAt !== null) {
    candidates.push({
      kind: "fired",
      at: schedule.lastFiredAt,
      taskId: schedule.lastTaskId,
      trigger: schedule.lastTrigger,
    });
  }
  if (schedule.lastSkippedAt !== null && schedule.lastSkipReason !== null) {
    candidates.push({ kind: "skipped", at: schedule.lastSkippedAt, reason: schedule.lastSkipReason });
  }
  if (schedule.lastErrorAt !== null && schedule.lastError !== null) {
    candidates.push({ kind: "failed", at: schedule.lastErrorAt, error: schedule.lastError });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, one) => (one.at > newest.at ? one : newest));
}

/**
 * The explanation strip under a row, or null when the last thing that happened was a plain fire.
 *
 * Only shown when there is something to explain. A row that fired cleanly says so in its
 * "Last fired" cell and does not need a second line repeating it.
 */
export function outcomeNote(schedule: Schedule): { tone: "attention" | "danger"; text: string } | null {
  const outcome = lastOutcome(schedule);
  if (!outcome) return null;
  if (outcome.kind === "skipped") {
    return { tone: "attention", text: `Skipped: ${skipReasonText(outcome.reason)}` };
  }
  if (outcome.kind === "failed") {
    return { tone: "danger", text: `The last fire could not be queued: ${outcome.error}` };
  }
  return null;
}
