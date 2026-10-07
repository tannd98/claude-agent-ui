import { FolderGit2, Lock, User } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";
import type { Scope } from "../lib/api.ts";

/**
 * Where a definition lives: `~/.claude` (User), `<cwd>/.claude` (Project), or a plugin's own
 * directory (read-only).
 *
 * Deliberately one neutral colour for all three. Hue in this app means *state* — green is live,
 * amber is "a human is needed", red is failed — and a scope is not a state. Telling the three
 * apart is the job of the word and the icon, which is the same rule StatusBadge follows for the
 * opposite reason (ux-guidelines No. 37: never colour alone). The lock on a plugin badge is the
 * one piece of information a scanner needs from the list: this one cannot be edited.
 */

interface ScopeSpec {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Read aloud and on hover, so the badge is not a word the user has to decode. */
  title: string;
}

const SPECS: Record<Scope, ScopeSpec> = {
  user: { label: "User", Icon: User, title: "Lives in ~/.claude — available in every project" },
  project: { label: "Project", Icon: FolderGit2, title: "Lives in this project's .claude directory" },
  plugin: { label: "Plugin", Icon: Lock, title: "Owned by an installed plugin — read-only" },
};

export interface ScopeBadgeProps {
  scope: Scope;
  /** The owning plugin's short name. Replaces the generic "Plugin" label when present. */
  plugin?: string | null;
  className?: string;
}

export function ScopeBadge({ scope, plugin, className }: ScopeBadgeProps) {
  const spec = SPECS[scope] ?? SPECS.user;
  const { Icon } = spec;
  const label = scope === "plugin" && plugin ? `${plugin} plugin` : spec.label;
  return (
    <span
      title={spec.title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[var(--badge-radius)] border",
        "border-[var(--scope-badge-border)] bg-[var(--scope-badge-bg)] text-[var(--scope-badge-fg)]",
        "px-[var(--badge-pad-x)] py-[var(--badge-pad-y)] text-2xs font-medium leading-tight",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}
