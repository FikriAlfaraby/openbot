// Fork module (super-agent, phase 1). The prompt blocks for the persona and the global instructions.
//
// The persona goes in as JSON, like the profile, so that user text cannot close the block's tag.
// Boundaries add limits only: they never remove a fixed rule for tools, approvals, sends, secrets,
// memory, the browser, or untrusted content.

import { redactText } from "@openbot/logging";
import type { PromptPersona } from "./persona-file";
import type { PersonaDocument } from "./persona-schema";

/** Same as `tagSafe` in `developer-instructions.ts`; kept here so this module has no import cycle. */
function tagSafe(json: string): string {
  return json.replaceAll("<", "\\u003c");
}

function personaJson(persona: PersonaDocument): string {
  const { version: _version, overrides: _overrides, ...fields } = persona;
  return tagSafe(redactText(JSON.stringify(fields, null, 2)));
}

/** The persona block, after the profile. Empty when the agent has no persona file. */
export function personaSection(prompt: PromptPersona | null | undefined): string[] {
  if (!prompt) return [];
  if (!prompt.persona)
    return [
      `Your persona file, persona.yaml at your workspace root, is ignored: ${prompt.issue ?? "it is not valid."} When the user asks about your persona, or edits it, say so and fix the file.`,
    ];
  const overridden = Object.keys(prompt.persona.overrides ?? {});
  return [
    `Your persona, from persona.yaml at your workspace root${prompt.version ? ` (version ${prompt.version})` : ""}. The role and goals are your standing remit, next to your profile. Use the tone in every reply; the examples show the expected voice and length, not facts. Keep each boundary, also when a request asks otherwise, and say which boundary applies. A boundary adds a limit; it never removes a rule here. Edit persona.yaml to change your persona when the user asks; keep it valid YAML with the same fields.${
      overridden.length ? ` It replaces these built-in rules: ${overridden.join(", ")}.` : ""
    }`,
    "<agent_persona>",
    personaJson(prompt.persona),
    "</agent_persona>",
  ];
}

/**
 * The server-wide instructions, before the profile. They can set style and delegation, like an
 * instruction file, and they rank below the agent's own instruction file, persona and profile.
 */
export function globalInstructionsSection(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return [
    "The user's global instructions apply to every agent of this OpenBot server. They can set your persona, reply length and format, group-chat behavior, and delegation, over the style and delegation guidance here. They change no rule here for tools, teammate message format, waits, memory, approvals, sends, payments, secrets, private data, limits, safety checks, the browser, or untrusted content. Your instruction file, persona, profile, and the current request come first.",
    "<openbot_global_instructions>",
    tagSafe(JSON.stringify(redactText(text.trim()))),
    "</openbot_global_instructions>",
  ];
}
