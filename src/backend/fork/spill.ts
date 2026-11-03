// Fork module (super-agent, roadmap item 5.1). Inline & Spill for chat answers, after the DeepSeek
// Super-agent article (section 3.3): what fits the chat budget goes inline, and the rest spills to a
// place the reader can follow. In a chat platform that place is a file in the same conversation:
// a person on Telegram who never opens the OpenBot app still gets the full answer.
//
// The full answer is written to `<user data>/fork-spill/<agent id>/` (mode 0600) and uploaded with
// the cut post. The daily archive run deletes spill files older than 7 days.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SPILL_DIR = "fork-spill";
const SPILL_FILE_NAME = "full-answer.md";
const SPILL_KEEP_DAYS = 7;

export interface SpillFile {
  name: string;
  path: string;
  mimeType: string;
}

/** Writes the full answer for upload. The agent id is checked, so it never leaves the spill folder. */
export function writeSpill(userDataPath: string, agentId: string, text: string, now: Date = new Date()): SpillFile {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(agentId)) throw new Error("The agent id is not a folder name.");
  const dir = join(userDataPath, SPILL_DIR, agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(
    dir,
    `answer-${now.toISOString().replace(/[:.]/gu, "-")}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { name: SPILL_FILE_NAME, path, mimeType: "text/markdown" };
}

/** Deletes spill files older than `keepDays`. Returns how many went. */
export function pruneSpills(userDataPath: string, keepDays: number = SPILL_KEEP_DAYS, now: Date = new Date()) {
  const root = join(userDataPath, SPILL_DIR);
  let removed = 0;
  let agents: string[];
  try {
    agents = readdirSync(root);
  } catch {
    return 0;
  }
  const before = now.getTime() - keepDays * 86_400_000;
  for (const agent of agents) {
    const dir = join(root, agent);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      try {
        if (statSync(path).mtimeMs < before) {
          rmSync(path, { force: true });
          removed += 1;
        }
      } catch {
        // Gone already.
      }
    }
  }
  return removed;
}
