import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type * as React from "react";
import { cn } from "../lib/utils.ts";
import { buttonVariants } from "./ui/button.tsx";

/**
 * The confirmation in front of every destructive action — ux-guidelines No. 35.
 *
 * Built on Radix AlertDialog, which gives us the three things a hand-rolled modal gets wrong:
 * focus is trapped inside while open, focus returns to the trigger on close, and Escape closes.
 * The default focus lands on Cancel, so a stray Enter cancels rather than deletes.
 */

export interface ConfirmDialogProps {
  /**
   * The control that opens it. Focus returns here when the dialog closes.
   *
   * Optional, for the controlled case where the confirmation guards a change rather than a
   * button — a switch that must not commit until the user has read what it does. Radix still
   * returns focus to whatever was focused when it opened, which is that control.
   */
  trigger?: React.ReactNode;
  title: string;
  /** What will happen, concretely. Name the thing being destroyed. */
  description: React.ReactNode;
  /** The verb, not "OK". "Delete run", "Stop agent". */
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** `danger` is the default; a non-destructive confirm can use `primary`. */
  tone?: "danger" | "primary";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  tone = "danger",
  open,
  onOpenChange,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay-scrim fixed inset-0 z-50 bg-[var(--overlay-scrim)]" />
        <AlertDialog.Content
          className={cn(
            "overlay-panel fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))]",
            "-translate-x-1/2 -translate-y-1/2",
            "rounded-[var(--overlay-radius)] border border-[var(--overlay-border)]",
            "bg-[var(--overlay-bg)] p-6 shadow-[var(--overlay-shadow)]",
          )}
        >
          <AlertDialog.Title className="text-lg font-semibold text-fg">{title}</AlertDialog.Title>
          {/* A div, not the default <p>: these descriptions run to two paragraphs when the thing
              being destroyed needs more than one sentence, and a <p> inside a <p> is invalid
              HTML that React warns about and the browser silently un-nests. */}
          <AlertDialog.Description asChild>
            <div className="mt-2 text-sm leading-relaxed text-fg-muted">{description}</div>
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel className={buttonVariants({ variant: "secondary", size: "md" })}>
              {cancelLabel}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              className={buttonVariants({ variant: tone === "danger" ? "danger" : "primary", size: "md" })}
              onClick={onConfirm}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
