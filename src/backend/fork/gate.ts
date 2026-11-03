// Fork module (super-agent, roadmap item 3.3). The gate for chat messages, after the DeepSeek
// prototype's Gate (`src/policy.ts`, `docs/002-authorization.md`): code decides before any model
// sees a message.
//
//   gate:
//     telegram:
//       mode: auto      # off | observe | auto
//       allow: ["123"]  # sender ids; omitted means everyone
//
// - `off`: nothing from the platform reaches an agent.
// - `auto`: a sender in `allow` (or everyone without `allow`) reaches the Router; others are dropped.
// - `observe`: a sender in `allow` reaches the Router; the others are only recorded in
//   `<OpenBot>/fork-observations.jsonl` (time, platform, chat, sender, the start of the text), so the
//   owner can read what the agent would have seen, without any agent acting on it.
// No `gate` block for a platform keeps upstream's behavior.
//
// Telegram never delivers another bot's messages to a bot, and OpenBot drops bot senders before
// this, so "bots as inferred candidates" of the prototype does not arise on Telegram.

import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "@openbot/logging";

const GATE_MODES = ["off", "observe", "auto"] as const;
type GateMode = (typeof GATE_MODES)[number];
export type GateDecision = "accept" | "observe" | "drop";

export interface PlatformGate {
  mode: GateMode;
  /** Sender ids that may give work; null for everyone. */
  allow: ReadonlySet<string> | null;
}

export interface GateMessage {
  authorId: string;
  isDirect: boolean;
}

/** What happens to a message: no gate for the platform accepts it, as upstream does. */
export function gateDecision(gate: PlatformGate | null | undefined, message: GateMessage): GateDecision {
  if (!gate) return "accept";
  if (gate.mode === "off") return "drop";
  const allowed = gate.allow === null || gate.allow.has(message.authorId);
  if (allowed) return "accept";
  return gate.mode === "observe" ? "observe" : "drop";
}

export const OBSERVATIONS_FILE_NAME = "fork-observations.jsonl";
const OBSERVATIONS_MAX_BYTES = 2 * 1024 * 1024;
const OBSERVED_TEXT = 500;

export interface Observation {
  platform: string;
  connectionId: string;
  chatId: string;
  threadKey: string;
  authorId: string;
  isDirect: boolean;
  text: string;
}

/**
 * Appends one observation line, redacted and cut, to the file in the OpenBot folder. Over 2 MiB the
 * file moves to `.1` and a new one starts, so it never grows without bound. A write that fails is
 * dropped: an observation must never stop the message flow.
 */
export function recordObservation(
  openbotRoot: string,
  observation: Observation,
  now: () => Date = () => new Date(),
): void {
  const path = join(openbotRoot, OBSERVATIONS_FILE_NAME);
  try {
    try {
      if (statSync(path).size > OBSERVATIONS_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No file yet.
    }
    const line = JSON.stringify({
      at: now().toISOString(),
      ...observation,
      text: Array.from(redactText(observation.text)).slice(0, OBSERVED_TEXT).join(""),
    });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {
    // See the doc comment.
  }
}
