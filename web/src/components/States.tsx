import { AlertTriangle, Inbox, RotateCw } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

/**
 * Empty, loading and error. An operator console spends more time in these three than on the
 * happy path, so they are a component rather than something each screen improvises.
 *
 * ux-guidelines No. 79 (Empty States): a message and an action, never blank space.
 * ux-guidelines No. 78 (Loading Indicators): a skeleton that reserves the real layout, so the
 * screen does not jump when the data lands.
 */

export interface EmptyStateProps {
  /** What is not here. Written as a plain sentence, not a word. */
  title: string;
  /** Why it is empty, and what the user can do about it. */
  description: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon: Icon = Inbox, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        // Fills whatever it is given so the message lands in the middle of the pane rather
        // than stranded at the top of a tall empty column.
        "flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <Icon className="size-6 text-fg-subtle" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-base font-medium text-fg">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-fg-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export interface LoadingStateProps {
  /** Announced to assistive tech; also the visually hidden caption. */
  label: string;
  /** How many skeleton rows to reserve. Match the list you expect so layout does not shift. */
  rows?: number;
  className?: string;
}

export function LoadingState({ label, rows = 5, className }: LoadingStateProps) {
  return (
    <div className={cn("space-y-px", className)} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-9 animate-pulse rounded-sm bg-surface-hover motion-reduce:animate-none"
          // Fade the stack downwards so it reads as "more below", not as five equal rows.
          style={{ opacity: 1 - i * 0.14 }}
        />
      ))}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

/** Pulls a sentence out of whatever was thrown, without ever rendering `[object Object]`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong, and the error carried no message.";
}

export function ErrorState({ title = "Could not load this", error, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <AlertTriangle className="size-6 text-danger-fg" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-base font-medium text-fg">{title}</p>
        <p className="mx-auto max-w-md text-sm text-fg-muted">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
