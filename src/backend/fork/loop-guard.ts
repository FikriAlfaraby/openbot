// Fork module (super-agent, roadmap item 4.2). A guard against an agent that calls the same OpenBot
// tool with the same input again and again while it keeps failing, which spends tokens and makes no
// progress. After `failures` such failures in a row within `windowMs`, the host refuses that call
// and tells the agent to change its approach or report the ticket blocked. Another input, another
// tool, or a success of that call starts the count again.
//
// It sees the OpenBot tools only. The provider's own tools (Bash, file edits) do not pass through
// OpenBot; the Watchdog's progress check covers those.

import { createHash } from "node:crypto";

const LOOP_GUARD_DEFAULTS = { failures: 3, windowMs: 10 * 60_000 } as const;

/** The most remembered failing calls per agent. */
const MAX_ENTRIES = 32;

/** The input as JSON with sorted keys, so the same input in another key order gives the same text. */
function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableText(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A short id of a tool and its input; the same input in another key order gives the same id. */
export function callSignature(tool: string, args: unknown): string {
  return `${tool}:${createHash("sha256")
    .update(stableText(args ?? null))
    .digest("hex")
    .slice(0, 16)}`;
}

function loopGuardRefusal(tool: string, failures: number): string {
  return `OpenBot stopped this ${tool} call: it failed ${failures} times in a row with the same input. Do not retry it as it is. Change the input or the approach; when the work cannot go on, report the ticket blocked with openbot.ticket_report, or tell the one who asked, and say what failed.`;
}

export class LoopGuard {
  readonly #failures: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #agents = new Map<string, Map<string, { count: number; at: number }>>();

  constructor(options: { failures?: number; windowMs?: number; now?: () => number } = {}) {
    this.#failures = options.failures ?? LOOP_GUARD_DEFAULTS.failures;
    this.#windowMs = options.windowMs ?? LOOP_GUARD_DEFAULTS.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** The refusal for this call, or null when it may run. */
  refusal(agentId: string, tool: string, args: unknown): string | null {
    const entry = this.#agents.get(agentId)?.get(callSignature(tool, args));
    if (!entry || entry.count < this.#failures) return null;
    if (this.#now() - entry.at > this.#windowMs) return null;
    return loopGuardRefusal(tool, entry.count);
  }

  /** Records how a call ended. */
  record(agentId: string, tool: string, args: unknown, success: boolean): void {
    const signature = callSignature(tool, args);
    let calls = this.#agents.get(agentId);
    if (success) {
      calls?.delete(signature);
      if (calls?.size === 0) this.#agents.delete(agentId);
      return;
    }
    if (!calls) {
      calls = new Map();
      this.#agents.set(agentId, calls);
    }
    const now = this.#now();
    const entry = calls.get(signature);
    const count = entry && now - entry.at <= this.#windowMs ? entry.count + 1 : 1;
    calls.delete(signature);
    calls.set(signature, { count, at: now });
    while (calls.size > MAX_ENTRIES) {
      const oldest = calls.keys().next().value;
      if (oldest === undefined) break;
      calls.delete(oldest);
    }
  }
}
