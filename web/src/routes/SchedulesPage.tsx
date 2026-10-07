import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Page } from "../components/Page.tsx";
import { ScheduleDialog } from "../components/ScheduleDialog.tsx";
import { ServerRunningNotice } from "../components/ServerRunningNotice.tsx";
import { EmptyState, ErrorState, LoadingState, errorMessage } from "../components/States.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Button } from "../components/ui/button.tsx";
import { SwitchControl } from "../components/ui/field.tsx";
import { deleteSchedule, listSchedules, queryKeys, runScheduleNow, updateSchedule, type Schedule } from "../lib/api.ts";
import { describeCron, formatInZone } from "../lib/cron.ts";
import { outcomeNote, scheduleBadge, skipReasonText } from "../lib/scheduleStatus.ts";
import { priorityLabel } from "../lib/taskStatus.ts";
import { cn, relativeTime } from "../lib/utils.ts";

/**
 * Columns that are supporting detail rather than the thing being scanned. Below `md` they
 * collapse to zero width, and what they carried reappears inside the name cell — the same
 * arrangement, and the same reason, as the Tasks table.
 */
const SECONDARY = "max-md:w-0 max-md:overflow-hidden max-md:p-0";

/** How often the relative times re-render. See {@link useClockTick}. */
const TICK_MS = 30_000;

/**
 * Re-render on a timer so "in 4 min" stops being a lie.
 *
 * This is **not** polling and it touches nothing on the network: `nextFireAt` already came down
 * with the schedule, and this only recomputes the sentence built from it. Without it a row
 * fetched an hour ago still claims the fire is four minutes away, which is worse than no
 * relative time at all. The exact wall clock sits underneath either way.
 */
function useClockTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);
}

/**
 * The Schedule screen: saved task templates and the cron clock that enqueues them.
 *
 * Everything on it arrives over SSE (`schedule:*` invalidate the `["schedules"]` key). Nothing
 * polls — see useEventStream.ts.
 */
export function SchedulesPage() {
  const schedules = useQuery({ queryKey: queryKeys.schedules, queryFn: listSchedules });
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useClockTick();

  const announce = useCallback((text: string) => setAnnouncement(text), []);

  const all = schedules.data ?? [];

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 6_000);
    return () => clearTimeout(timer);
  }, [highlightId]);

  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(schedule: Schedule) {
    setEditing(schedule);
    setDialogOpen(true);
  }

  function handleSaved(saved: Schedule, created: boolean) {
    setHighlightId(saved.id);
    announce(created ? `Created the schedule "${saved.name}".` : `Saved changes to "${saved.name}".`);
  }

  return (
    <Page
      title="Schedule"
      description="Cron schedules that add a task to the queue"
      actions={
        <Button variant="primary" size="md" onClick={openNew}>
          <Plus aria-hidden="true" />
          New schedule
        </Button>
      }
    >
      {/* Polite and never focus-moving — a row changing under the cursor must not steal focus
          from the control someone is tabbed into (ux-guidelines No. 118). */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* Above the table, on every visit, before anyone depends on a 03:00 job. */}
      <ServerRunningNotice />

      {schedules.error ? (
        <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : schedules.isLoading ? (
        <LoadingState label="Loading schedules" rows={5} className="p-6" />
      ) : all.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description="A schedule is a saved task template plus a cron expression. When it fires it adds a task to the queue, which is still the one place work starts."
          action={
            <Button variant="primary" onClick={openNew}>
              <Plus aria-hidden="true" />
              New schedule
            </Button>
          }
        />
      ) : (
        /* table-fixed with the widths on the header row, for the reason the Tasks table has
           them there: a long skip explanation in one cell must not be able to squeeze the name
           column, which is the one being scanned. */
        <table className="mt-6 w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Schedules, oldest first</caption>
          <thead>
            <tr
              className={cn(
                "border-y border-border bg-[var(--table-header-bg)]",
                "text-left text-2xs font-semibold uppercase tracking-[var(--tracking-wide)]",
                "text-[var(--table-header-fg)]",
              )}
            >
              {/* State collapses below `md` too: at 390px its 96px is the difference between
                  four reachable actions and a clipped Delete. The badge itself is not dropped,
                  it moves — see the copy under the name in ScheduleRow. Leaving only the toggle
                  would have made "is this on?" a question about thumb position and hue. */}
              <th
                scope="col"
                className={cn("w-[var(--schedule-state-col-width)] py-[var(--table-cell-pad-y)] pl-6 pr-3", SECONDARY)}
              >
                State
              </th>
              <th scope="col" className="px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)]">
                Schedule
              </th>
              <th
                scope="col"
                className={cn("w-36 px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)]", SECONDARY)}
              >
                Last fired
              </th>
              <th
                scope="col"
                className={cn("w-44 px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)]", SECONDARY)}
              >
                Next fire
              </th>
              {/* Wide enough at 390px for all four controls at their 24px minimum target —
                  measured, not guessed: 40 + 3x30 + gaps + padding. A clipped Delete is a
                  destructive action that is not reachable from the row. */}
              <th
                scope="col"
                className={cn(
                  "w-56 py-[var(--table-cell-pad-y)] pl-3 pr-6 text-right",
                  "max-md:w-40 max-md:pl-1 max-md:pr-3",
                )}
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {all.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                expanded={expandedId === schedule.id}
                onToggle={() => setExpandedId(expandedId === schedule.id ? null : schedule.id)}
                highlighted={highlightId === schedule.id}
                onEdit={() => openEdit(schedule)}
                onAnnounce={announce}
              />
            ))}
          </tbody>
        </table>
      )}

      <ScheduleDialog open={dialogOpen} onOpenChange={setDialogOpen} schedule={editing} onSaved={handleSaved} />
    </Page>
  );
}

/* ---------------------------------------------------------------------------------------- */

interface ScheduleRowProps {
  schedule: Schedule;
  expanded: boolean;
  onToggle: () => void;
  highlighted: boolean;
  onEdit: () => void;
  onAnnounce: (text: string) => void;
}

/** A row-local message: the answer to the button the user just pressed, next to that button. */
interface RowMessage {
  tone: "quiet" | "attention" | "danger";
  text: string;
  /** The task a successful "run once now" created, so the result is one click from the row. */
  taskId?: string;
}

function ScheduleRow({ schedule, expanded, onToggle, highlighted, onEdit, onAnnounce }: ScheduleRowProps) {
  const badge = scheduleBadge(schedule);
  const note = outcomeNote(schedule);
  const english = describeCron(schedule.cron);
  const row = useRef<HTMLTableRowElement>(null);
  const [message, setMessage] = useState<RowMessage | null>(null);

  useEffect(() => {
    if (highlighted) row.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });

  function handleError(error: unknown) {
    invalidate();
    setMessage({ tone: "danger", text: errorMessage(error) });
  }

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateSchedule(schedule.id, { enabled }),
    onSuccess: (saved) => {
      setMessage(null);
      onAnnounce(
        saved.enabled
          ? `"${saved.name}" is on. Next fire ${saved.nextFireAt === null ? "unknown" : relativeTime(saved.nextFireAt)}.`
          : `"${saved.name}" is off. The cron clock will not fire it.`,
      );
      invalidate();
    },
    onError: handleError,
  });

  const runNow = useMutation({
    mutationFn: () => runScheduleNow(schedule.id),
    // A suppressed fire comes back 200 — being told "not now, the previous run is waiting on a
    // permission prompt" is the route working, so it is rendered as the reason it is, never as
    // a failure. This is the single most important behaviour on the screen.
    onSuccess: (result) => {
      if (result.fired) {
        setMessage({ tone: "quiet", text: "Queued a task now.", taskId: result.taskId });
        onAnnounce(`"${schedule.name}" queued a task now.`);
      } else {
        const text = `Not queued: ${skipReasonText(result.reason)}`;
        setMessage({ tone: "attention", text });
        onAnnounce(`"${schedule.name}" — ${text}`);
      }
      invalidate();
    },
    onError: handleError,
  });

  const remove = useMutation({
    mutationFn: () => deleteSchedule(schedule.id),
    onSuccess: () => {
      onAnnounce(`Deleted the schedule "${schedule.name}". Tasks it already queued are not affected.`);
      invalidate();
    },
    onError: handleError,
  });

  const busy = toggle.isPending || runNow.isPending || remove.isPending;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  // The note/expansion row belongs to this row, so the rule between them comes off: otherwise
  // "Skipped: …" reads as a banner floating between two schedules, and half the time a user
  // attributes it to the wrong one.
  const hasDetail = Boolean(note || message || expanded);

  return (
    <>
      <tr
        ref={row}
        className={cn(
          "h-[var(--schedule-row-height)]",
          !hasDetail && "border-b border-[var(--table-border)]",
          "transition-colors duration-[var(--duration-fast)] hover:bg-[var(--table-row-bg-hover)]",
          expanded && "bg-[var(--table-row-bg-selected)]",
          highlighted && "outline outline-2 -outline-offset-2 outline-[var(--color-accent)]",
        )}
      >
        <td className={cn("py-[var(--table-cell-pad-y)] pl-6 pr-3 align-middle", SECONDARY)}>
          {/* `max-md:hidden`, not just a zero-width cell: a collapsed cell is still read out,
              and the mobile copy in the line under the name would double the announcement. */}
          <span className="block max-md:hidden">
            <StatusBadge status={badge.status} label={badge.label} title={badge.title} />
          </span>
        </td>

        <td className="px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)] align-middle">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm text-left"
          >
            <Chevron aria-hidden="true" className="size-3 shrink-0 text-fg-subtle" />
            <span className="min-w-0 flex-1 truncate font-medium text-fg">{schedule.name}</span>
          </button>
          {/* At 390px the State column is collapsed, so the badge comes back here — and it has
              to come back somewhere: without it the only thing left saying whether a schedule
              is on is the toggle, and a toggle says "on" by thumb position and hue alone, which
              is the one thing a status in this app may never do (ux-guidelines No. 37).
              "Disabled — will not fire" covers the off case on the Next line, but an enabled
              schedule had no word at all.

              Directly under the name rather than at the end of the stack: after the name, the
              state is the thing being scanned for, so it does not belong below the timezone. */}
          <span className="mt-1 hidden pl-[var(--row-text-indent)] max-md:block">
            <StatusBadge status={badge.status} label={badge.label} title={badge.title} />
          </span>
          {/*
            The sentence *next to* the expression, never instead of it. The raw field is what the
            server validates and what gets edited, so hiding it would make the one thing you have
            to get right the one thing you cannot see — and the timezone rides along, because a
            cron expression without its zone is only two thirds of the answer.
          */}
          <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 pl-[var(--row-text-indent)] text-2xs">
            <span className="text-fg-muted">{english ?? "A custom pattern"}</span>
            <code className="font-mono text-fg-subtle">{schedule.cron}</code>
            <span className="text-fg-subtle">{schedule.timezone}</span>
          </span>
          {/* The two time columns are collapsed at 390px too, and the next fire is the thing
              someone opens this screen to check. */}
          <span className="mt-0.5 hidden pl-[var(--row-text-indent)] text-2xs text-fg-muted max-md:block">
            Next: <NextFire schedule={schedule} inline />
          </span>
        </td>

        <td className={cn("px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)] align-middle text-xs", SECONDARY)}>
          <LastFired schedule={schedule} />
        </td>

        <td className={cn("px-[var(--table-cell-pad-x)] py-[var(--table-cell-pad-y)] align-middle text-xs", SECONDARY)}>
          {/* Unlike Last fired, this one has a mobile copy above, so it has to leave the
              a11y tree below `md` rather than just lose its width. */}
          <span className="block max-md:hidden">
            <NextFire schedule={schedule} />
          </span>
        </td>

        {/* Row actions, in the row. Nothing here is buried in a detail page. */}
        <td className="py-[var(--table-cell-pad-y)] pl-3 pr-6 text-right align-middle max-md:pl-1 max-md:pr-3">
          <span className="inline-flex items-center justify-end gap-1.5 max-md:gap-1">
            <SwitchControl
              checked={schedule.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => toggle.mutate(enabled)}
              aria-label={`Enabled — ${schedule.name}`}
            />

            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`Run ${schedule.name} once now`}
              // Honest about both halves: the toggle governs the cron clock, so this still works
              // on a disabled row — but it does not skip the overlap check, because the reason
              // for not stacking runs does not stop applying because a person asked.
              title={
                schedule.enabled
                  ? "Add this schedule's task to the queue now. The overlap check still applies."
                  : "This schedule is off, but running it once now still works. The overlap check still applies."
              }
              onClick={() => runNow.mutate()}
            >
              <Play aria-hidden="true" />
              <span className="max-md:sr-only">Run now</span>
            </Button>

            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Edit ${schedule.name}`} onClick={onEdit}>
              <Pencil aria-hidden="true" />
            </Button>

            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${schedule.name}`}>
                  <Trash2 aria-hidden="true" />
                </Button>
              }
              title="Delete this schedule?"
              description={
                <>
                  <p>“{schedule.name}” will stop firing and its saved task template is gone. This cannot be undone.</p>
                  <p className="mt-2">Tasks it has already queued are not affected — they stay in the queue and run.</p>
                </>
              }
              confirmLabel="Delete schedule"
              cancelLabel="Keep it"
              onConfirm={() => remove.mutate()}
            />
          </span>
        </td>
      </tr>

      {hasDetail && (
        <tr
          className={cn(
            "border-b border-[var(--table-border)]",
            // The same surface as the row above when it is open, so the pair reads as one
            // block; sunken when the row is closed, so a note is clearly subordinate to it.
            expanded ? "bg-[var(--table-row-bg-selected)]" : "bg-[var(--color-surface-sunken)]",
          )}
        >
          {/* Indented to the Schedule column: a note that starts at the page edge belongs to
              the table, and this one belongs to one row. */}
          <td colSpan={5} className="py-3 pr-6 pl-[calc(var(--schedule-state-col-width)+var(--space-6))] max-md:pl-4">
            {/*
              The whole answer to "why did my 09:00 not run", in words, without being asked for.
              It sits outside the disclosure on purpose: a reason nobody expands to find is a
              reason that does not exist.
            */}
            {note && (
              <p
                className={cn(
                  "text-xs leading-normal",
                  note.tone === "danger" ? "text-danger-fg" : "text-[var(--notice-fg)]",
                )}
              >
                {note.text}
              </p>
            )}
            {message && (
              <p
                role="status"
                className={cn(
                  "text-xs leading-normal",
                  note && "mt-2",
                  message.tone === "danger"
                    ? "text-danger-fg"
                    : message.tone === "attention"
                      ? "text-[var(--notice-fg)]"
                      : "text-fg-muted",
                )}
              >
                {message.text}{" "}
                {message.taskId && (
                  <Link to={`/tasks/${message.taskId}`} className="text-accent-fg underline-offset-2 hover:underline">
                    Open it in Tasks
                  </Link>
                )}
              </p>
            )}
            {expanded && <ScheduleExpansion schedule={schedule} className={note || message ? "mt-3" : undefined} />}
          </td>
        </tr>
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------------------- */

function LastFired({ schedule }: { schedule: Schedule }) {
  if (schedule.lastFiredAt === null) {
    return <span className="text-fg-subtle">Never</span>;
  }
  return (
    <span className="block">
      <time dateTime={new Date(schedule.lastFiredAt).toISOString()} className="block text-fg-muted">
        {relativeTime(schedule.lastFiredAt)}
      </time>
      {/* The zone is named here for the same reason the next-fire column names it, facing
          backwards: "2 hours ago" read against the wrong wall clock is how an operator decides
          the wrong run is the one they are looking at. A `title` only answers that for a mouse,
          so the exact time is on the page, not in a tooltip. */}
      <span className="mt-0.5 block text-2xs text-fg-subtle">
        {formatInZone(schedule.lastFiredAt, schedule.timezone)} · {schedule.timezone}
        {schedule.lastTrigger === "manual" && " · run by hand"}
      </span>
    </span>
  );
}

/**
 * When it fires next — never a time the schedule will not honour.
 *
 * A disabled schedule says "Disabled", not "tomorrow at 09:00": the second is a promise the user
 * only discovers was false at 09:01. The server sends `nextFireAt: null` for exactly this case.
 */
function NextFire({ schedule, inline = false }: { schedule: Schedule; inline?: boolean }) {
  if (!schedule.enabled) {
    return <span className={cn("text-fg-subtle", !inline && "block")}>Disabled — will not fire</span>;
  }
  if (schedule.nextFireAt === null) {
    return (
      <span
        className={cn("text-fg-subtle", !inline && "block")}
        title="This pattern has no future match — a date that has passed, for example."
      >
        Never again
      </span>
    );
  }
  const exact = formatInZone(schedule.nextFireAt, schedule.timezone);
  if (inline) {
    return (
      <time dateTime={new Date(schedule.nextFireAt).toISOString()} title={exact} className="text-fg-muted">
        {relativeTime(schedule.nextFireAt)} · {exact}
      </time>
    );
  }
  return (
    <span className="block">
      <time dateTime={new Date(schedule.nextFireAt).toISOString()} className="block text-fg">
        {relativeTime(schedule.nextFireAt)}
      </time>
      {/* The zone is named, always. A schedule written for Asia/Ho_Chi_Minh and read in London
          is the exact mistake this column exists to prevent. */}
      <span className="mt-0.5 block text-2xs text-fg-subtle">
        {exact} · {schedule.timezone}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------------------------------- */

function ScheduleExpansion({ schedule, className }: { schedule: Schedule; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 text-sm", className)}>
      <h3 className="text-xs font-medium text-fg">The task this adds to the queue</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <Meta label="Agent">
          <span className="font-mono text-2xs">{schedule.task.agent}</span>
        </Meta>
        <Meta label="Working directory">
          <span className="font-mono text-2xs">{schedule.task.cwd}</span>
        </Meta>
        <Meta label="Prompt">
          <span className="whitespace-pre-wrap">{schedule.task.prompt}</span>
        </Meta>
        <Meta label="Permissions">
          {schedule.task.permissionMode === "ask" ? "Asks before each tool use" : "Skips every permission prompt"}
        </Meta>
        <Meta label="Unattended">{schedule.task.unattended ? "Yes — it will not stop to ask questions" : "No"}</Meta>
        <Meta label="Priority">{priorityLabel(schedule.task.priority)}</Meta>
        <Meta label="If the last task has not finished">
          {schedule.overlapPolicy === "skip"
            ? "Skip the firing, and record why"
            : "Queue it anyway — unless the previous run is waiting on a permission prompt"}
        </Meta>
        {schedule.lastTaskId && (
          <Meta label="Last task">
            <Link to={`/tasks/${schedule.lastTaskId}`} className="text-accent-fg underline-offset-2 hover:underline">
              Open it in Tasks
            </Link>
          </Meta>
        )}
      </dl>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-fg-subtle">{label}</dt>
      <dd className="min-w-0 text-fg-muted">{children}</dd>
    </>
  );
}
