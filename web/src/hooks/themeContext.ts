import { createContext, useContext } from "react";
import type { Theme } from "./useTheme.ts";

/**
 * One theme instance for the app. Separated from useTheme.ts so the hook file stays free of
 * JSX and Vite's fast refresh keeps working on both.
 */
export const ThemeContext = createContext<Theme | null>(null);

export function useThemeContext(): Theme {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useThemeContext must be used inside <AppProviders>");
  return value;
}
