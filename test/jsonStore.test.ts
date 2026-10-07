import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JsonStore, sweepTempFiles, writeFileAtomic } from "../src/store/jsonStore.ts";
import { put, tempHome } from "./helpers.ts";

const store = <T>(dir: string, empty: () => T, name = "state.json") => new JsonStore<T>(path.join(dir, name), empty);

test("read returns the empty value when the file does not exist", async () => {
  const dir = await tempHome();
  assert.deepEqual(await store<number[]>(dir, () => []).read(), []);
});

test("mutate creates the directory and writes the value back", async () => {
  const dir = path.join(await tempHome(), "nested", "deeper");
  const s = store<number[]>(dir, () => []);
  const result = await s.mutate((v) => {
    v.push(1, 2);
    return v.length;
  });
  assert.equal(result, 2);
  assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")), [1, 2]);
});

test("concurrent mutations are serialised, so none is lost", async () => {
  const dir = await tempHome();
  const s = store<number[]>(dir, () => []);
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.mutate((v) => v.push(i))));
  const saved: number[] = JSON.parse(await readFile(s.file, "utf8"));
  assert.deepEqual(
    [...saved].sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i),
  );
});

test("a failed mutation rejects for its caller but does not break the chain", async () => {
  const dir = await tempHome();
  const s = store<number[]>(dir, () => []);
  await s.mutate((v) => v.push(1));
  await assert.rejects(
    s.mutate(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await s.mutate((v) => v.push(2));
  assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")), [1, 2]);
});

test("an unreadable file is an error, not a silent reset", async () => {
  const dir = await tempHome();
  const s = store<number[]>(dir, () => []);
  await put(s.file, "{not json");
  await assert.rejects(s.read());
  await assert.rejects(s.mutate((v) => v.push(1)));
  assert.equal(await readFile(s.file, "utf8"), "{not json");
});

test("writeFileAtomic replaces the file and leaves no temp file behind", async () => {
  const dir = await tempHome();
  const file = path.join(dir, "state.json");
  await writeFile(file, "old");
  await writeFileAtomic(file, "new");
  assert.equal(await readFile(file, "utf8"), "new");
  assert.deepEqual(
    (await readdir(dir)).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("two stores on the same file serialise against each other, so neither write is lost", async () => {
  const dir = await tempHome();
  const file = path.join(dir, "state.json");
  const a = new JsonStore<number[]>(file, () => []);
  const b = new JsonStore<number[]>(file, () => []);
  await Promise.all([a.mutate((v) => v.push(1)), b.mutate((v) => v.push(2))]);
  // Without a chain shared per file, both would read [] and the later write would drop the other.
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([...saved].sort(), [1, 2]);
  assert.deepEqual(
    (await readdir(dir)).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("a path reached two ways is one chain, and an equivalent path resolves to the same one", async () => {
  const dir = await tempHome();
  const file = path.join(dir, "state.json");
  const stores = [
    new JsonStore<number[]>(file, () => []),
    new JsonStore<number[]>(path.join(dir, ".", "state.json"), () => []),
    new JsonStore<number[]>(path.join(dir, "sub", "..", "state.json"), () => []),
  ];
  await Promise.all(stores.flatMap((s, i) => [0, 1].map((j) => s.mutate((v) => v.push(i * 2 + j)))));
  const saved: number[] = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(
    [...saved].sort((x, y) => x - y),
    [0, 1, 2, 3, 4, 5],
  );
});

test("a rejected mutation does not wedge the chain for the next caller", async () => {
  const dir = await tempHome();
  const file = path.join(dir, "state.json");
  const store = new JsonStore<number[]>(file, () => []);
  await assert.rejects(
    store.mutate(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await store.mutate((v) => v.push(1));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [1]);
});

const CRASH_WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "crashWriter.ts");
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Spawns the crash-writer child and resolves once it has printed `line`.
 *
 * `exited` is attached at spawn time on purpose: a child that finishes its write before the test
 * kills it emits `exit` first, and a listener added afterwards would wait for an event that has
 * already been and gone.
 */
async function startWriter(
  file: string,
  mode: "staged" | "race",
  line: string,
): Promise<{ child: ChildProcess; exited: Promise<unknown> }> {
  const child = spawn(process.execPath, ["--import", "tsx", CRASH_WRITER, file, mode], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  let seen = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      seen += chunk;
      if (seen.includes(line)) resolve();
    });
    child.once("exit", () => reject(new Error(`writer exited before printing "${line}": ${seen}`)));
    child.once("error", reject);
  });
  return { child, exited };
}

const OLD = { v: "old" };

test("a kill between the temp write and the rename leaves the previous file intact", { timeout: 60_000 }, async () => {
  const dir = await tempHome();
  const file = path.join(dir, "runs.json");
  await writeFile(file, JSON.stringify(OLD));

  const { child, exited } = await startWriter(file, "staged", "staged");
  child.kill("SIGKILL");
  await exited;

  // The new value never landed, and the old file is byte-for-byte what it was.
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), OLD);
  // The temp file it was killed on top of is an orphan; the next start sweeps it.
  assert.equal(
    (await readdir(dir)).filter((f) => f.endsWith(".tmp")).length,
    1,
    "expected the orphaned temp file to still be there",
  );
  assert.equal(await sweepTempFiles(dir), 1);
  assert.deepEqual((await readdir(dir)).sort(), ["runs.json"], "the sweep must take the temp file and nothing else");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), OLD);
});

test("a kill at an arbitrary point in a write never leaves a half-written file", { timeout: 120_000 }, async () => {
  for (const delay of [1, 10, 40]) {
    const dir = await tempHome();
    const file = path.join(dir, "runs.json");
    await writeFile(file, JSON.stringify(OLD));

    const { child, exited } = await startWriter(file, "race", "writing");
    await new Promise((resolve) => setTimeout(resolve, delay));
    child.kill("SIGKILL");
    await exited;

    // Whenever the kill landed, a reader sees one whole value: the old one or the new one.
    const saved = JSON.parse(await readFile(file, "utf8")) as { v: string };
    assert.ok(saved.v === "old" || saved.v === "new", `unexpected value after a kill at ${delay}ms`);
  }
});
