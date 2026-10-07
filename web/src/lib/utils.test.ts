import { describe, expect, it } from "vitest";
import { ordinal, plural, relativeTime } from "./utils.ts";

describe("plural", () => {
  it("agrees with its count", () => {
    expect(plural(0, "task")).toBe("0 tasks");
    expect(plural(1, "task")).toBe("1 task");
    expect(plural(2, "task")).toBe("2 tasks");
  });

  it("takes an irregular plural", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-03-10T12:00:00Z");
  const ago = (ms: number) => relativeTime(now - ms, now);

  it("collapses the last minute to a phrase rather than a count", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(30_000)).toBe("just now");
  });

  it("steps up through the units", () => {
    expect(ago(4 * 60_000)).toMatch(/4 min/);
    expect(ago(3 * 3_600_000)).toMatch(/3 hr/);
    expect(ago(2 * 86_400_000)).toMatch(/2 days/);
  });

  it("handles a clock-skewed future timestamp without producing nonsense", () => {
    expect(relativeTime(now + 5 * 60_000, now)).toMatch(/5 min/);
  });
});

describe("ordinal", () => {
  it("reads the way a person would say it", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
      "101st",
      "111th",
    ]);
  });
});
