import { Bot, CalendarClock, ListChecks, Sparkles } from "lucide-react";
import type * as React from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

export interface NavArea {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** One line explaining what lives here, shown under the label on the active item. */
  hint: string;
}

/** The four areas, in the order the plan fixed them. */
export const NAV_AREAS: NavArea[] = [
  { to: "/agents", label: "Agents", icon: Bot, hint: "Agent definitions and runs" },
  { to: "/skills", label: "Skills", icon: Sparkles, hint: "Skills on disk" },
  { to: "/tasks", label: "Tasks", icon: ListChecks, hint: "The work queue" },
  { to: "/schedule", label: "Schedule", icon: CalendarClock, hint: "Recurring runs" },
];

export function Sidebar() {
  return (
    <nav
      aria-label="Main"
      className={cn(
        "flex w-[var(--sidebar-width)] shrink-0 flex-col",
        "max-md:w-[var(--sidebar-width-collapsed)]",
        "border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)]",
      )}
    >
      <div
        className={cn(
          "flex h-[var(--topbar-height)] items-center gap-2 px-4",
          "border-b border-[var(--sidebar-border)] max-md:justify-center max-md:px-0",
        )}
      >
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
        <span className="text-sm font-semibold tracking-tight text-fg max-md:hidden">Claude Agent UI</span>
      </div>

      <ul className="flex flex-1 flex-col gap-px p-2">
        {NAV_AREAS.map((area) => (
          <li key={area.to}>
            <NavLink
              to={area.to}
              // The rail hides the label, so the icon needs its own name. Below `md` this is
              // the only thing a screen reader or a hover has to go on.
              title={`${area.label} — ${area.hint}`}
              aria-label={area.label}
              // The active item is the only one carrying a left marker and a solid surface:
              // a stranger can tell where they are without reading the labels.
              className={({ isActive }) =>
                cn(
                  "group relative flex h-[var(--sidebar-item-height)] items-center gap-2.5",
                  "rounded-[var(--radius-md)] pl-3 pr-2 text-sm",
                  "max-md:justify-center max-md:px-0",
                  "transition-colors duration-[var(--duration-fast)]",
                  isActive
                    ? "bg-[var(--sidebar-item-bg-active)] font-medium text-[var(--sidebar-item-fg-active)]"
                    : "text-[var(--sidebar-item-fg)] hover:bg-[var(--sidebar-item-bg-hover)] hover:text-[var(--sidebar-item-fg-hover)]",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute left-0 h-4 w-0.5 rounded-full transition-opacity duration-[var(--duration-fast)]",
                      isActive ? "bg-[var(--sidebar-item-marker-active)] opacity-100" : "opacity-0",
                    )}
                  />
                  <area.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="max-md:hidden">{area.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="border-t border-[var(--sidebar-border)] p-2">
        <ThemeToggle />
      </div>
    </nav>
  );
}
