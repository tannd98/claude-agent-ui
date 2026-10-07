import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, with later Tailwind utilities winning over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `3` → `"3 runs"`, `1` → `"1 run"`. Counts in this UI are always read aloud with their noun. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * `1` → `"1st"`. Recognition over recall: "3rd of 7" reads, "position 3" has to be decoded.
 *
 * Here rather than beside either caller: the queue reads it as a position and the schedule
 * screen reads it as a day of the month, and one of those having its own copy is how the two
 * drift on `11th`.
 */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

const UNITS: [limitSeconds: number, perUnit: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3_600, 60, "minute"],
  [86_400, 3_600, "hour"],
  [604_800, 86_400, "day"],
  [2_629_800, 604_800, "week"],
  [31_557_600, 2_629_800, "month"],
  [Infinity, 31_557_600, "year"],
];

/**
 * `"4 min ago"`. An operator scanning a run list wants elapsed time, not a wall clock they
 * have to subtract from — the exact timestamp stays available as the cell's tooltip.
 */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = (timestamp - now) / 1000;
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return "just now";
  const [, perUnit, unit] = UNITS.find(([limit]) => magnitude < limit) ?? UNITS[UNITS.length - 1]!;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
  return format.format(Math.round(seconds / perUnit), unit);
}
