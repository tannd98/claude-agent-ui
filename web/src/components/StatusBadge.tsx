import {
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Clock,
  Loader2,
  MessageCircleQuestion,
  OctagonAlert,
  XCircle,
} from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

/**
 * The one way this app shows a state.
 *
 * ux-guidelines No. 37 (Color Only): every badge renders a word and an icon as well as a hue,
 * so it survives greyscale, a colour-blind reader and a screen reader. There is no variant that
 * renders the dot alone — that is the point of the component existing.
 */
export type Status =
  | "running"
  | "waiting"
  | "blocked"
  | "queued"
  | "scheduled"
  | "finished"
  | "failed"
  | "cancelled"
  | "idle"
  | "missing"
  | "unknown";

interface StatusSpec {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Component-layer colour pair; both resolve through the semantic layer. */
  fg: string;
  bg: string;
  spin?: boolean;
}

const SPECS: Record<Status, StatusSpec> = {
  running: {
    label: "Running",
    Icon: Loader2,
    fg: "var(--status-running-fg)",
    bg: "var(--status-running-bg)",
    spin: true,
  },
  // "Needs input", not "Waiting": the operator is the thing it is waiting for, and the label
  // is the only part of this badge that says so.
  waiting: {
    label: "Needs input",
    Icon: MessageCircleQuestion,
    fg: "var(--status-waiting-fg)",
    bg: "var(--status-waiting-bg)",
  },
  // The agent stopped itself and said why — it is not failed, and it is not finished. It shares
  // amber with `waiting` because it means the same thing to an operator: this one needs you.
  blocked: {
    label: "Blocked",
    Icon: OctagonAlert,
    fg: "var(--status-blocked-fg)",
    bg: "var(--status-blocked-bg)",
  },
  queued: { label: "Queued", Icon: Clock, fg: "var(--status-queued-fg)", bg: "var(--status-queued-bg)" },
  scheduled: {
    label: "Scheduled",
    Icon: CalendarClock,
    fg: "var(--status-scheduled-fg)",
    bg: "var(--status-scheduled-bg)",
  },
  finished: {
    label: "Finished",
    Icon: CheckCircle2,
    fg: "var(--status-finished-fg)",
    bg: "var(--status-finished-bg)",
  },
  failed: { label: "Failed", Icon: XCircle, fg: "var(--status-failed-fg)", bg: "var(--status-failed-bg)" },
  // Neutral, not red: the user asked for this. It is history, not a fault.
  cancelled: {
    label: "Cancelled",
    Icon: CircleSlash,
    fg: "var(--status-idle-fg)",
    bg: "var(--status-idle-bg)",
  },
  idle: { label: "Idle", Icon: CircleDot, fg: "var(--status-idle-fg)", bg: "var(--status-idle-bg)" },
  // The run record survived but its session did not — usually a reboot. Distinct from
  // "Unknown", which means we could not read the session list at all this time.
  missing: { label: "Missing", Icon: CircleSlash, fg: "var(--status-idle-fg)", bg: "var(--status-idle-bg)" },
  unknown: { label: "Unknown", Icon: CircleDashed, fg: "var(--status-idle-fg)", bg: "var(--status-idle-bg)" },
};

export interface StatusBadgeProps {
  status: Status;
  /** Overrides the default word. The badge is never label-less. */
  label?: string;
  /** Extra detail on hover, e.g. what a waiting run is waiting for. */
  title?: string;
  className?: string;
}

export function StatusBadge({ status, label, title, className }: StatusBadgeProps) {
  const spec = SPECS[status] ?? SPECS.unknown;
  const { Icon } = spec;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--badge-radius)] px-[var(--badge-pad-x)]",
        "py-[var(--badge-pad-y)] text-xs font-medium leading-tight",
        className,
      )}
      style={{ color: spec.fg, backgroundColor: spec.bg }}
    >
      <Icon
        aria-hidden="true"
        // motion-safe: the running spinner is the only animation in the app, and it stops
        // for prefers-reduced-motion (ux-guidelines No. 9).
        className={cn("size-3", spec.spin && "motion-safe:animate-spin")}
      />
      {label ?? spec.label}
    </span>
  );
}
