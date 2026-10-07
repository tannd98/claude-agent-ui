import { Monitor, Moon, Sun } from "lucide-react";
import type * as React from "react";
import { useThemeContext } from "../hooks/themeContext.ts";
import type { ThemePreference } from "../hooks/useTheme.ts";
import { cn } from "../lib/utils.ts";

const OPTIONS: { value: ThemePreference; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "light", label: "Light", Icon: Sun },
];

/**
 * Three explicit choices rather than a two-state switch.
 *
 * A toggle cannot express "follow the OS", which is the default and the one most people want;
 * making it a radio group states all three and shows which is live — recognition over recall.
 */
export function ThemeToggle() {
  const { preference, resolved, setPreference } = useThemeContext();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      // On the collapsed rail the three options stack; there is no room for them side by side.
      className={cn(
        "flex items-center gap-px rounded-[var(--radius-md)] bg-surface-sunken p-0.5",
        "max-md:flex-col max-md:items-stretch",
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            // A screen reader should hear what "System" currently means, not just the word.
            aria-label={value === "system" ? `System (currently ${resolved})` : label}
            title={value === "system" ? `System (currently ${resolved})` : label}
            onClick={() => setPreference(value)}
            className={cn(
              "flex h-6 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-sm)]",
              "text-2xs transition-colors duration-[var(--duration-fast)]",
              selected ? "bg-surface-raised font-medium text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            <span className="max-md:hidden">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
