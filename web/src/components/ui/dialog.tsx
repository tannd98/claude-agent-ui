import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "./button.tsx";

/**
 * The non-destructive modal: a form the user fills in and submits.
 *
 * ConfirmDialog is its sibling for "are you sure" — that one is an AlertDialog, which steals
 * focus to Cancel and refuses to close on an outside click. This one behaves like a form: focus
 * lands inside the panel, Escape and the backdrop close it. Both get the same focus trap and
 * the same focus restore on close.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogPanelProps {
  title: string;
  /** One line under the title saying what this form does. Shown, and used as the a11y description. */
  description: string;
  children: React.ReactNode;
  /** Buttons, right-aligned under a hairline. */
  footer?: React.ReactNode;
  className?: string;
}

export function DialogPanel({ title, description, children, footer, className }: DialogPanelProps) {
  /**
   * Where focus came from, so it can be given back.
   *
   * Radix restores focus to a `<Dialog.Trigger>` and to nothing else: its own close handler
   * calls `preventDefault()` and then `triggerRef.current?.focus()`. Every dialog in this app
   * is opened from state — a row's Edit button, a page's New button — so there is no Trigger,
   * that ref is null, and focus lands on `<body>`: a keyboard user who presses Escape is
   * dropped at the top of the document and has to tab all the way back.
   *
   * `onOpenAutoFocus` fires while the previously focused element is still the active one, which
   * is the one moment it can be read. Preventing the default on close stops Radix's own
   * (broken, here) restore from running.
   */
  const restoreTo = React.useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="overlay-scrim fixed inset-0 z-50 bg-[var(--overlay-scrim)]" />
      <DialogPrimitive.Content
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          restoreTo.current = active instanceof HTMLElement ? active : null;
        }}
        onCloseAutoFocus={(event) => {
          // Only when the element is still in the document: a dialog that deleted the row it
          // was opened from must fall back to Radix rather than focus a detached node.
          if (!restoreTo.current?.isConnected) return;
          event.preventDefault();
          restoreTo.current.focus();
        }}
        className={cn(
          "overlay-panel fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-var(--space-8))] w-[min(34rem,calc(100vw-2rem))]",
          "-translate-x-1/2 -translate-y-1/2 flex-col",
          "rounded-[var(--overlay-radius)] border border-[var(--overlay-border)]",
          "bg-[var(--overlay-bg)] shadow-[var(--overlay-shadow)]",
          className,
        )}
      >
        <div className="flex items-start gap-4 px-6 pb-4 pt-6">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-lg font-semibold leading-tight text-fg">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1 text-sm leading-normal text-fg-muted">
              {description}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" aria-label="Close">
              <X aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
