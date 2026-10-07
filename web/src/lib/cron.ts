/**
 * Cron expressions, in English.
 *
 * ux-guidelines No. 85 (Date Formatting) and the recognition-over-recall rule: `0 9 * * 1-5` is
 * a thing an operator decodes, and decoding it wrong is how a job silently runs at the wrong
 * hour. The screen shows the sentence *next to* the expression, never instead of it — the raw
 * field is what gets edited and what the server validates, so hiding it would make the one
 * thing you must get right the one thing you cannot see.
 *
 * Deliberately not a dependency. `cronstrue` would be ~12kB for a sentence we need to word
 * ourselves anyway ("every weekday at 09:00", not "At 09:00 AM, Monday through Friday"), and
 * this file has to agree with croner's dialect specifically — six fields with seconds first.
 *
 * Honest about its limits: anything outside the patterns below returns `null` rather than a
 * guess, and the screen says "a custom pattern" and leans on the raw expression. A wrong
 * English sentence next to a right cron expression is worse than no sentence at all.
 */

import { ordinal } from "./utils.ts";

/** 24-hour everywhere. The cron field is already 24-hour, so anything else invites a mis-read. */
const pad = (n: number) => String(n).padStart(2, "0");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** croner's shorthands, expanded to the five-field form so there is one code path below. */
const NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/**
 * One parsed field. `every` is a bare `*`; `step` is the slash form (`* / n`, `a-b / n`, written
 * without the spaces); `values` is everything else, already expanded and sorted so the describer
 * never re-parses a range.
 */
type Field =
  { kind: "every" } | { kind: "step"; step: number; from: number; to: number } | { kind: "values"; values: number[] };

function parseField(raw: string, min: number, max: number, aliases?: Record<string, number>): Field | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (text === "*" || text === "?") return { kind: "every" };

  // A lone slash form is a rhythm ("every 15 minutes"); mixed into a comma list it stops being
  // one, so only the un-listed form gets the step treatment.
  if (!text.includes(",")) {
    const step = parseStep(text, min, max, aliases);
    if (step) return step;
  }

  const values = new Set<number>();
  for (const part of text.split(",")) {
    const expanded = expandPart(part, min, max, aliases);
    if (!expanded) return null;
    for (const value of expanded) values.add(value);
  }
  if (values.size === 0) return null;
  return { kind: "values", values: [...values].sort((a, b) => a - b) };
}

function parseStep(text: string, min: number, max: number, aliases?: Record<string, number>): Field | null {
  const slash = text.indexOf("/");
  if (slash === -1) return null;
  const step = Number(text.slice(slash + 1));
  if (!Number.isInteger(step) || step < 1) return null;
  const head = text.slice(0, slash);
  if (head === "*") return { kind: "step", step, from: min, to: max };
  const dash = head.indexOf("-");
  if (dash === -1) return null;
  const from = readNumber(head.slice(0, dash), aliases);
  const to = readNumber(head.slice(dash + 1), aliases);
  if (from === null || to === null || from < min || to > max || from > to) return null;
  return { kind: "step", step, from, to };
}

function expandPart(part: string, min: number, max: number, aliases?: Record<string, number>): number[] | null {
  // A step inside a comma list: expand it to its values rather than refusing the whole field.
  const slash = part.indexOf("/");
  if (slash !== -1) {
    const stepped = parseStep(part, min, max, aliases);
    if (!stepped || stepped.kind !== "step") return null;
    const out: number[] = [];
    for (let v = stepped.from; v <= stepped.to; v += stepped.step) out.push(v);
    return out;
  }
  const dash = part.indexOf("-");
  if (dash > 0) {
    const from = readNumber(part.slice(0, dash), aliases);
    const to = readNumber(part.slice(dash + 1), aliases);
    if (from === null || to === null || from < min || to > max || from > to) return null;
    const out: number[] = [];
    for (let v = from; v <= to; v += 1) out.push(v);
    return out;
  }
  const single = readNumber(part, aliases);
  if (single === null || single < min || single > max) return null;
  return [single];
}

/**
 * Is a step field a rhythm, or a bounded burst wearing a rhythm's clothes?
 *
 * The open form `* / 2` on the hour field fires every two hours, all day. `0-6/2` fires three
 * times and then stops until tomorrow. Both parse to `kind: "step"` with the same `step`, and
 * every sentence below ("every 2 hours") is only true of the first — the upper bound is the
 * whole difference, and dropping it tells the operator the job runs more often than it does.
 *
 * A bounded range earns the sentence only when it fires on exactly the values the open form
 * would: it starts at the field's floor, and it runs at least as far as its own last fire.
 * `0-57/5` fires on the same twelve minutes as `* / 5`, so both get "every 5 minutes";
 * `0-30/5` does not, and falls back to the raw expression.
 */
function coversWholeRange(field: Extract<Field, { kind: "step" }>, min: number, max: number): boolean {
  if (field.from !== min) return false;
  return field.to >= max - ((max - min) % field.step);
}

function readNumber(raw: string, aliases?: Record<string, number>): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (aliases && text in aliases) return aliases[text]!;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

/** `["a","b","c"]` → `"a, b and c"`. Oxford comma deliberately omitted; this is UI, not prose. */
function list(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * How many distinct clock times a sentence is allowed to spell out before it stops being
 * readable at a glance. Past this the raw expression is the better answer, so we return null.
 */
const MAX_LISTED_TIMES = 4;

/**
 * And how many days of the month, for the same reason. "the 8th, 9th, 10th, 11th, 12th, 13th
 * and 14th of every month" is correct and still harder to read than the `8-14` it came from.
 * Past this many, the expression is the better sentence.
 */
const MAX_LISTED_DAYS = 4;

interface DayPhrase {
  /** The sentence subject: "every weekday", "the 1st of every month". */
  subject: string;
  /** The adverbial form, for a sentence that already starts with a rhythm. Null for "every day". */
  qualifier: string | null;
}

function describeDays(dom: Field, month: Field, dow: Field): DayPhrase | null {
  const domRestricted = dom.kind !== "every";
  const dowRestricted = dow.kind !== "every";

  // Vixie cron ORs a restricted day-of-month with a restricted day-of-week, croner included.
  // "the 1st of the month, and also every Monday" is a sentence nobody reads correctly at a
  // glance, so this is one of the cases where the raw expression is the honest answer.
  if (domRestricted && dowRestricted) return null;

  if (dowRestricted) {
    if (dow.kind === "step") return null;
    // 0 and 7 are both Sunday; normalise before comparing sets.
    const days = [...new Set(dow.values.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
    const monthPhrase = describeMonths(month);
    if (monthPhrase === null) return null;
    const key = days.join(",");
    const named =
      key === "1,2,3,4,5"
        ? { subject: "every weekday", qualifier: "on weekdays" }
        : key === "0,6"
          ? { subject: "every weekend day", qualifier: "at the weekend" }
          : key === "0,1,2,3,4,5,6"
            ? { subject: "every day", qualifier: null }
            : {
                subject: `every ${list(days.map((d) => DAY_NAMES[d]!))}`,
                qualifier: `on ${list(days.map((d) => `${DAY_NAMES[d]!}s`))}`,
              };
    if (!monthPhrase) return named;
    return {
      subject: `${named.subject} in ${monthPhrase}`,
      qualifier: `${named.qualifier ?? "every day"} in ${monthPhrase}`,
    };
  }

  if (domRestricted) {
    if (dom.kind === "step") {
      if (!coversWholeRange(dom, 1, 31)) return null;
      const every = dom.step === 1 ? "every day" : `every ${ordinal(dom.step)} day`;
      const monthPhrase = describeMonths(month);
      if (monthPhrase === null) return null;
      const subject = monthPhrase ? `${every} of ${monthPhrase}` : `${every} of the month`;
      return { subject, qualifier: `on ${subject.replace(/^every /, "every ")}` };
    }
    if (dom.values.length > MAX_LISTED_DAYS) return null;
    const dayList = list(dom.values.map((d) => ordinal(d)));
    const monthPhrase = describeMonths(month);
    if (monthPhrase === null) return null;
    const subject = `the ${dayList} of ${monthPhrase || "every month"}`;
    return { subject, qualifier: `on ${subject}` };
  }

  const monthPhrase = describeMonths(month);
  if (monthPhrase === null) return null;
  if (monthPhrase) return { subject: `every day in ${monthPhrase}`, qualifier: `every day in ${monthPhrase}` };
  return { subject: "every day", qualifier: null };
}

/** `""` for "every month"; `null` when the field is beyond this describer. */
function describeMonths(month: Field): string | null {
  if (month.kind === "every") return "";
  if (month.kind === "step") return null;
  if (month.values.length > 3) return null;
  return list(month.values.map((m) => MONTH_NAMES[m - 1] ?? String(m)));
}

/** A rhythm ("every 15 minutes") or a set of clock times ("09:00 and 17:00"). */
type TimePhrase = { kind: "interval"; text: string } | { kind: "at"; times: string[] };

function describeTime(second: Field | null, minute: Field, hour: Field): TimePhrase | null {
  // --- Seconds. Only the three shapes that mean something to a person. ------------------
  if (second && second.kind !== "values") {
    if (minute.kind !== "every" || hour.kind !== "every") return null;
    if (second.kind === "every") return { kind: "interval", text: "every second" };
    if (!coversWholeRange(second, 0, 59)) return null;
    return { kind: "interval", text: `every ${second.step} seconds` };
  }
  if (second && second.values.length > 1) return null;
  const secondValue = second ? second.values[0]! : 0;

  // --- A minute or hour rhythm ----------------------------------------------------------
  if (minute.kind === "step") {
    if (secondValue !== 0 || !coversWholeRange(minute, 0, 59)) return null;
    const rhythm = minute.step === 1 ? "every minute" : `every ${minute.step} minutes`;
    if (hour.kind === "every") return { kind: "interval", text: rhythm };
    if (hour.kind === "values" && hour.values.length === 1) {
      const h = hour.values[0]!;
      return { kind: "interval", text: `${rhythm} between ${pad(h)}:00 and ${pad(h)}:59` };
    }
    return null;
  }

  if (minute.kind === "every") {
    if (secondValue !== 0) return null;
    if (hour.kind === "every") return { kind: "interval", text: "every minute" };
    if (hour.kind === "values" && hour.values.length === 1) {
      const h = hour.values[0]!;
      return { kind: "interval", text: `every minute between ${pad(h)}:00 and ${pad(h)}:59` };
    }
    return null;
  }

  if (hour.kind === "step") {
    if (!coversWholeRange(hour, 0, 23) || minute.values.length !== 1 || secondValue !== 0) return null;
    const m = minute.values[0]!;
    const rhythm = hour.step === 1 ? "every hour" : `every ${hour.step} hours`;
    return { kind: "interval", text: m === 0 ? `${rhythm}, on the hour` : `${rhythm} at :${pad(m)}` };
  }

  if (hour.kind === "every") {
    if (secondValue !== 0) return null;
    if (minute.values.length === 1) {
      const m = minute.values[0]!;
      return { kind: "interval", text: m === 0 ? "every hour, on the hour" : `every hour at :${pad(m)}` };
    }
    if (minute.values.length > MAX_LISTED_TIMES) return null;
    return { kind: "interval", text: `every hour at ${list(minute.values.map((m) => `:${pad(m)}`))}` };
  }

  // --- Plain clock times ------------------------------------------------------------------
  const times: string[] = [];
  for (const h of hour.values) {
    for (const m of minute.values) {
      times.push(secondValue === 0 ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(secondValue)}`);
    }
  }
  if (times.length > MAX_LISTED_TIMES) return null;
  return { kind: "at", times: times.sort() };
}

/**
 * A cron expression as a sentence, or null when it is beyond this describer.
 *
 * Accepts croner's five- and six-field forms (six puts **seconds first**) and its `@daily`
 * shorthands. Never throws: a malformed expression is just one it cannot describe, and the
 * server is the thing that rejects it.
 */
export function describeCron(expression: string): string | null {
  const raw = expression?.trim();
  if (!raw) return null;
  const normalised = NICKNAMES[raw.toLowerCase()] ?? raw;

  const fields = normalised.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const sixField = fields.length === 6;

  const second = sixField ? parseField(fields[0]!, 0, 59) : null;
  const offset = sixField ? 1 : 0;
  const minute = parseField(fields[offset]!, 0, 59);
  const hour = parseField(fields[offset + 1]!, 0, 23);
  const dom = parseField(fields[offset + 2]!, 1, 31);
  const month = parseField(fields[offset + 3]!, 1, 12, MONTH_ALIASES);
  const dow = parseField(fields[offset + 4]!, 0, 7, DAY_ALIASES);
  if ((sixField && !second) || !minute || !hour || !dom || !month || !dow) return null;

  const days = describeDays(dom, month, dow);
  const time = describeTime(second, minute, hour);
  if (!days || !time) return null;

  if (time.kind === "at") return `${days.subject} at ${list(time.times)}`;
  return days.qualifier ? `${time.text} ${days.qualifier}` : time.text;
}

/**
 * The wall-clock time in the schedule's own zone, with the zone named.
 *
 * Both halves matter. A schedule written for `Asia/Ho_Chi_Minh` and read in London is the exact
 * mistake this screen exists to prevent, so the zone is never left implied — and the relative
 * time beside it ("in 14 min") is what answers "is this soon" without any subtraction at all.
 */
export function formatInZone(timestamp: number, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat(undefined, options).format(timestamp);
  } catch {
    // The server validates the zone on save, so this only happens to a record written by an
    // older build. Showing the browser's zone beats showing nothing.
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
  }
}
