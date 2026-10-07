import type * as React from "react";
import { cn } from "../lib/utils.ts";

/**
 * List on the left, editor on the right. Agents and Skills both use this shape.
 *
 * Below `md` the two panes stack and only one is shown, because a 360px-wide editor next to a
 * 360px-wide list is two unusable panes rather than one usable one. The caller decides which
 * by passing `mobilePane`.
 */

export interface TwoPaneProps {
  /** Accessible name for the list region, e.g. "Agents". */
  listLabel: string;
  list: React.ReactNode;
  /** Accessible name for the detail region, e.g. "Agent editor". */
  detailLabel: string;
  detail: React.ReactNode;
  /** Which pane is visible on narrow screens. */
  mobilePane?: "list" | "detail";
  /** List column width. From the spacing scale — not a free-form px value. */
  listWidth?: string;
  className?: string;
}

export function TwoPane({
  listLabel,
  list,
  detailLabel,
  detail,
  mobilePane = "list",
  listWidth = "20rem",
  className,
}: TwoPaneProps) {
  return (
    <div className={cn("flex min-h-0 flex-1 overflow-hidden", className)}>
      <section
        aria-label={listLabel}
        // Width goes through a custom property rather than an inline `width`, so the
        // `max-md:w-full` class can still win below the breakpoint.
        style={{ "--two-pane-list-width": listWidth } as React.CSSProperties}
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface",
          "w-[var(--two-pane-list-width)] max-md:w-full max-md:border-r-0",
          mobilePane === "detail" && "max-md:hidden",
        )}
      >
        {list}
      </section>
      <section
        aria-label={detailLabel}
        className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg", mobilePane === "list" && "max-md:hidden")}
      >
        {detail}
      </section>
    </div>
  );
}
