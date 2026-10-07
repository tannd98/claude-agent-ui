import { Info } from "lucide-react";
import { cn } from "../lib/utils.ts";

/**
 * The limitation, said out loud, where someone reads it before they rely on a 03:00 job.
 *
 * This is a deliberate design decision, not a bug being hidden: schedules live in this process,
 * there is no daemon, and a fire missed while the server was down is **not** replayed — because
 * replaying would mean a laptop opened on Monday launching every overnight job at once.
 *
 * Two placements, one component. The screen shows the full version above the table on every
 * visit; the create/edit form shows the compact one, because deciding to depend on a schedule is
 * the moment the sentence actually matters.
 *
 * Not a toast and not dismissible — ux-guidelines No. 82: toasts are for transient, non-critical
 * messages, and this is permanent. Not amber either: in this app amber means "a human is needed
 * here" (see the status tokens), and a notice that is true on every single visit would burn that
 * meaning out by the second day. It reads as information, with its own tokens.
 */
export function ServerRunningNotice({ compact = false }: { compact?: boolean }) {
  return (
    <aside
      className={cn(
        "flex items-start gap-2.5 border-l-2 border-[var(--limitation-border)]",
        "bg-[var(--limitation-bg)] text-[var(--limitation-fg)]",
        compact ? "rounded-[var(--radius-md)] px-3 py-2" : "mx-6 mt-6 rounded-[var(--radius-md)] px-4 py-3",
      )}
    >
      <Info aria-hidden="true" className={cn("mt-px shrink-0", compact ? "size-3.5" : "size-4")} />
      <p className={cn("leading-normal", compact ? "text-xs" : "text-sm")}>
        <strong className="font-medium text-[var(--limitation-fg-strong)]">
          Schedules only fire while this server is running.
        </strong>{" "}
        There is no background daemon. If the server is not running when a schedule is due, that firing is skipped — and
        it is never replayed afterwards.
      </p>
    </aside>
  );
}
