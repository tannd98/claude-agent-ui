import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

/** Finds ~/.claude/projects/<any>/<sessionId>.jsonl without recomputing the cwd slug. */
export async function findTranscript(home: string, sessionId: string): Promise<string | null> {
  const root = path.join(home, ".claude", "projects");
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = path.join(root, dir.name, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not in this project folder
    }
  }
  return null;
}

export interface FinalMessage {
  text: string;
  timestamp: string | null;
}

/**
 * Returns the text of the last assistant message that has text.
 * One API message can be split over several lines sharing message.id, so text blocks are grouped by id.
 */
export function extractFinalMessage(jsonl: string): FinalMessage | null {
  let lastId: string | null = null;
  let parts: string[] = [];
  let timestamp: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || entry.isSidechain) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text);
    if (!texts.length) continue;
    const id = entry.message?.id ?? entry.uuid ?? null;
    if (id === null || id !== lastId) {
      lastId = id;
      parts = [];
    }
    parts.push(...texts);
    timestamp = entry.timestamp ?? timestamp;
  }
  return lastId === null && !parts.length ? null : { text: parts.join("\n\n").trim(), timestamp };
}

export async function readFinalMessage(file: string): Promise<FinalMessage | null> {
  return extractFinalMessage(await readFile(file, "utf8"));
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms, or null when the line carried no timestamp — it is optional in the JSONL. */
  at: number | null;
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  /** True when older messages were dropped to keep the response bounded. */
  truncated: boolean;
}

/** How many messages a transcript read returns at most. An agent session's JSONL is unbounded. */
export const DEFAULT_TRANSCRIPT_LIMIT = 200;

/** One parsed message plus the API message id used to rejoin lines that were split across entries. */
interface Pending extends TranscriptMessage {
  id: string | null;
}

/** Pulls the displayable text out of one JSONL entry, or null when it carries none. */
function entryText(entry: any): string | null {
  const content = entry?.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  // Everything else in the array is protocol traffic — thinking, tool_use, tool_result.
  const texts = content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text);
  const joined = texts.join("\n\n").trim();
  return joined || null;
}

/**
 * Reads the last `limit` user and assistant messages from a transcript.
 *
 * Streamed line by line and held in a ring of `limit` entries, so a multi-megabyte session is
 * never loaded into memory whole — neither here nor in the response it turns into.
 */
export async function readMessages(file: string, limit = DEFAULT_TRANSCRIPT_LIMIT): Promise<TranscriptPage> {
  const kept: Pending[] = [];
  let dropped = false;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const role = entry?.type;
      if ((role !== "user" && role !== "assistant") || entry.isSidechain) continue;
      const text = entryText(entry);
      if (text === null) continue;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) || null : null;
      const id = entry.message?.id ?? null;
      const last = kept[kept.length - 1];
      // One API message can arrive as several lines sharing message.id; join them rather than
      // showing the same reply as a handful of fragments.
      if (last && id !== null && last.id === id && last.role === role) {
        last.text += `\n\n${text}`;
        continue;
      }
      kept.push({ role, text, at, id });
      if (kept.length > limit) {
        kept.shift();
        dropped = true;
      }
    }
  } finally {
    lines.close();
  }
  return { messages: kept.map(({ id: _id, ...message }) => message), truncated: dropped };
}
