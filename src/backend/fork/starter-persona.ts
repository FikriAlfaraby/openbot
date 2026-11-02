// Fork module (super-agent, roadmap item P.8). A new agent gets a starter `persona.yaml` from its
// profile, so that every bot has a persona to edit from its first session. An existing file is never
// replaced, and a starter that the schema refuses is not written.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { stringify } from "yaml";
import { PERSONA_FILE_NAME, PERSONA_LIMITS, parsePersona } from "../agent/persona/persona-schema";

export interface StarterProfile {
  name: string;
  title: string;
  description: string;
}

const STARTER_TONE = "Short and clear. Reply in the language of the person who wrote.";

/** The first sentence, cut to `max` characters at a word. */
function firstSentence(text: string, max: number): string {
  const sentence = (text.trim().split(/(?<=[.!?])\s/u)[0] ?? "").replace(/\s+/gu, " ").trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

/** The starter text for a profile, or null when the profile gives nothing valid. */
export function starterPersonaText(profile: StarterProfile): string | null {
  const role = (profile.title.trim() || profile.name.trim()).slice(0, PERSONA_LIMITS.role);
  if (!role) return null;
  const goal = firstSentence(profile.description, PERSONA_LIMITS.line);
  const summary = firstSentence(profile.description, PERSONA_LIMITS.routingSummary);
  const document = {
    version: 1,
    role,
    ...(goal ? { goals: [goal] } : {}),
    tone: STARTER_TONE,
    ...(summary ? { routing_summary: summary } : {}),
  };
  const text = [
    "# Starter persona, made from the agent's profile. Edit it, or replace it with a template from",
    "# docs/fork/agents/ (router, coder, researcher). Check it: bun scripts/persona.ts validate persona.yaml",
    stringify(document, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
  return parsePersona(text).ok ? text : null;
}

/** Writes the starter persona into a new agent's workspace, unless a persona file is there already. */
export const writeStarterPersona = Effect.fn("StarterPersona.write")(function* (
  workspace: string,
  profile: StarterProfile,
) {
  const text = starterPersonaText(profile);
  if (!text) return false;
  return yield* Effect.tryPromise({
    // `wx` never replaces a file, also one that appeared since the check.
    try: () => writeFile(join(workspace, PERSONA_FILE_NAME), text, { flag: "wx", mode: 0o600 }),
    catch: () => null,
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});
