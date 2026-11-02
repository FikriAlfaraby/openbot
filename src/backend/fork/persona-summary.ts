// Fork module (super-agent, roadmap item P.1). The `routing_summary` of an agent's `persona.yaml`, for
// `list_agents`: the Router routes by it instead of the profile description cut at 300 characters.
// Synchronous with a cache by file size and time, because `list_agents` reads every agent at once.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_FILE_NAME, PERSONA_LIMITS, parsePersona } from "../agent/persona/persona-schema";

const cache = new Map<string, { stamp: string; summary: string | null }>();

/** The routing summary of the persona in `workspace`, or null without a valid one. */
export function routingSummaryOf(workspace: string): string | null {
  const path = join(workspace, PERSONA_FILE_NAME);
  let stamp: string;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > PERSONA_LIMITS.fileBytes) return null;
    stamp = `${info.size}:${info.mtimeMs}`;
  } catch {
    cache.delete(path);
    return null;
  }
  const cached = cache.get(path);
  if (cached?.stamp === stamp) return cached.summary;
  let summary: string | null = null;
  try {
    const parsed = parsePersona(readFileSync(path, "utf8"));
    summary = parsed.ok ? (parsed.persona.routing_summary ?? null) : null;
  } catch {
    summary = null;
  }
  cache.set(path, { stamp, summary });
  return summary;
}
