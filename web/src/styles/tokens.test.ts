import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The token layer is only a system if nothing bypasses it. This is the guard: a raw hex, an
 * rgb() or a CDN font link in a component is a build-time failure rather than something a
 * reviewer has to spot by eye.
 */

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const componentFiles = walk(srcDir).filter(
  (file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
);

const rel = (file: string) => path.relative(srcDir, file);

describe("token discipline", () => {
  it("finds the component tree to check", () => {
    expect(componentFiles.length).toBeGreaterThan(10);
  });

  it("has no raw colour literals outside the token layer", () => {
    const offenders = componentFiles
      .map((file) => {
        const hits = readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line: line.trim(), n: i + 1 }))
          // #abc / #aabbcc, and rgb()/hsl() with literal channels.
          .filter(({ line }) => /#[0-9a-fA-F]{3,8}\b/.test(line) || /\b(rgb|hsl)a?\(\s*\d/.test(line));
        return { file: rel(file), hits };
      })
      .filter(({ hits }) => hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it("loads no asset from a remote host", () => {
    const remote = /https?:\/\/(?!127\.0\.0\.1|localhost)/;
    const offenders = walk(srcDir)
      .filter((file) => /\.(tsx?|css)$/.test(file))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ file: rel(file), n: i + 1, line: line.trim() }))
          // Prose in a comment may name a CDN in order to rule it out; only real
          // declarations count, so skip comment lines before matching.
          .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
          .filter(({ line }) => remote.test(line)),
      );

    expect(offenders).toEqual([]);
  });
});
