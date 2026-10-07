import type * as React from "react";
import { cn } from "../lib/utils.ts";

/**
 * The header every screen shares: title on the left, actions on the right, one hairline under.
 * Having it here is what keeps the four screens on the same baseline — the title sits at the
 * same height on Agents as it does on Schedule.
 */
export interface PageProps {
  title: string;
  /** One line under the title. Says what this screen is for, not what it is called. */
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Set when the screen manages its own scrolling (a two-pane layout, for example). */
  bodyClassName?: string;
}

export function Page({ title, description, actions, children, bodyClassName }: PageProps) {
  return (
    <>
      <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-4 border-b border-border px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold leading-tight text-fg">{title}</h1>
          {description && <p className="truncate text-xs leading-tight text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("min-h-0 flex-1 overflow-auto", bodyClassName)}>{children}</div>
    </>
  );
}
