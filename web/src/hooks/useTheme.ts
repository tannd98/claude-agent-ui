import { useCallback, useEffect, useState } from "react";

/** What the user chose. `system` is the default and follows the OS. */
export type ThemePreference = "system" | "dark" | "light";
/** What is actually painted. */
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "cau.theme";

/**
 * `system` resolves to light only when the OS explicitly asks for it. A machine with no
 * preference expressed gets dark, which is the product default.
 *
 * Mirrored by the inline script in index.html so the first paint is already correct —
 * change both together.
 */
export function resolveTheme(pref: ThemePreference, prefersLight: boolean): ResolvedTheme {
  if (pref === "system") return prefersLight ? "light" : "dark";
  return pref;
}

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    // Private browsing can throw on access, not just on write.
    return "system";
  }
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export interface Theme {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

export function useTheme(): Theme {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [prefersLight, setPrefersLight] = useState(
    () => typeof window !== "undefined" && window.matchMedia(LIGHT_QUERY).matches,
  );

  // Follow the OS live: a user flipping their system theme should see this window follow
  // without a reload, as long as they have not pinned a preference.
  useEffect(() => {
    const mql = window.matchMedia(LIGHT_QUERY);
    const onChange = (e: MediaQueryListEvent) => setPrefersLight(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(preference, prefersLight);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    // Tells the browser to theme form controls, scrollbars and the canvas to match.
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice must not stop us honouring it this session.
    }
  }, []);

  return { preference, resolved, setPreference };
}
