import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { extractFinalMessage, findTranscript, readMessages } from "../src/claude/transcript.ts";
import { put, tempHome } from "./helpers.ts";

const line = (o: object) => JSON.stringify(o);
const assistant = (id: string, content: object[], extra: object = {}) =>
  line({ type: "assistant", timestamp: `t-${id}`, message: { id, role: "assistant", content }, ...extra });

test("returns the last assistant text, grouping split message lines", () => {
  const jsonl = [
    line({ type: "user", message: { content: "hi" } }),
    assistant("m1", [{ type: "text", text: "LAUNCHED" }]),
    assistant("m2", [{ type: "thinking", thinking: "..." }]),
    assistant("m2", [{ type: "text", text: "Part A" }]),
    assistant("m2", [{ type: "tool_use", name: "Bash", input: {} }]),
    assistant("m2", [{ type: "text", text: "Part B" }]),
    assistant("s1", [{ type: "text", text: "sidechain" }], { isSidechain: true }),
    "not json",
    "",
  ].join("\n");
  assert.deepEqual(extractFinalMessage(jsonl), { text: "Part A\n\nPart B", timestamp: "t-m2" });
});

test("no assistant text yields null", () => {
  assert.equal(extractFinalMessage(line({ type: "user" })), null);
});

/** Writes `jsonl` into a temp home and reads it back through readMessages. */
async function readFixture(jsonl: string, limit?: number) {
  const file = path.join(await tempHome(), "session.jsonl");
  await put(file, jsonl);
  return readMessages(file, limit);
}

test("readMessages returns user and assistant text, rejoining split lines", async () => {
  const jsonl = [
    line({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "do it" } }),
    assistant("m1", [{ type: "thinking", thinking: "..." }]),
    assistant("m1", [{ type: "text", text: "Part A" }]),
    assistant("m1", [{ type: "tool_use", name: "Bash", input: {} }]),
    assistant("m1", [{ type: "text", text: "Part B" }]),
    // Protocol traffic, not something anyone said: a tool result carries no displayable text.
    line({ type: "user", message: { content: [{ type: "tool_result", content: "exit 0" }] } }),
    assistant("s1", [{ type: "text", text: "sidechain" }], { isSidechain: true }),
    "not json",
  ].join("\n");
  assert.deepEqual(await readFixture(jsonl), {
    messages: [
      { role: "user", text: "do it", at: Date.parse("2026-01-01T00:00:00.000Z") },
      { role: "assistant", text: "Part A\n\nPart B", at: null },
    ],
    truncated: false,
  });
});

test("readMessages keeps only the last `limit` messages and says it truncated", async () => {
  // The JSONL of a long session is unbounded; neither the response nor the read may be.
  const jsonl = Array.from({ length: 10 }, (_, i) => assistant(`m${i}`, [{ type: "text", text: `msg ${i}` }])).join(
    "\n",
  );
  const page = await readFixture(jsonl, 3);
  assert.equal(page.truncated, true);
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["msg 7", "msg 8", "msg 9"],
  );
  assert.equal((await readFixture(jsonl, 10)).truncated, false);
});

test("findTranscript searches every project folder", async () => {
  const home = await tempHome();
  const file = path.join(home, ".claude", "projects", "-Users-x-Workspace", "abc-123.jsonl");
  await put(file, "");
  assert.equal(await findTranscript(home, "abc-123"), file);
  assert.equal(await findTranscript(home, "missing"), null);
});
