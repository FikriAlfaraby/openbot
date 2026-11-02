// Fork module (super-agent, phase 1). The format of `persona.yaml` in an agent's workspace.
//
// The file gives an agent a structured persona: role, goals, tone, boundaries, examples, and a
// short routing summary for delegation. `overrides` replaces built-in style rules by key; see
// `overridable-rules.ts`. Every field is optional, and an unknown field is an error, so a typo does
// not silently drop a rule.

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Result, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import type { OverridableRuleKey } from "./overridable-rules";

export const PERSONA_FILE_NAME = "persona.yaml";

/** Characters and counts. The whole block stays well under the 32 000 characters of an instruction file. */
export const PERSONA_LIMITS = {
  /** The bytes that a read takes from the file. A larger file is refused. */
  fileBytes: 64_000,
  line: 300,
  role: 600,
  tone: 600,
  routingSummary: 300,
  goals: 12,
  boundaries: 24,
  examples: 6,
  exampleText: 1_200,
  override: 1_500,
} as const;

const Line = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(PERSONA_LIMITS.line));
const Text = (max: number) => Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(max));

const PersonaExample = Schema.Struct({
  user: Text(PERSONA_LIMITS.exampleText),
  agent: Text(PERSONA_LIMITS.exampleText),
});

const OverrideText = Text(PERSONA_LIMITS.override);

/** One optional text for each key of `OVERRIDABLE_RULES`; `satisfies` keeps the two lists equal. */
const overrideFields = {
  style: Schema.optionalKey(OverrideText),
  remit: Schema.optionalKey(OverrideText),
  group_chat: Schema.optionalKey(OverrideText),
} satisfies Record<OverridableRuleKey, Schema.optionalKey<typeof OverrideText>>;

export const PersonaDocument = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  role: Schema.optionalKey(Text(PERSONA_LIMITS.role)),
  goals: Schema.optionalKey(Schema.Array(Line).check(Schema.isMaxLength(PERSONA_LIMITS.goals))),
  tone: Schema.optionalKey(Text(PERSONA_LIMITS.tone)),
  boundaries: Schema.optionalKey(Schema.Array(Line).check(Schema.isMaxLength(PERSONA_LIMITS.boundaries))),
  examples: Schema.optionalKey(Schema.Array(PersonaExample).check(Schema.isMaxLength(PERSONA_LIMITS.examples))),
  routing_summary: Schema.optionalKey(Text(PERSONA_LIMITS.routingSummary)),
  overrides: Schema.optionalKey(Schema.Struct(overrideFields)),
});

export type PersonaDocument = typeof PersonaDocument.Type;

const decodePersonaDocument = Schema.decodeUnknownResult(PersonaDocument, { onExcessProperty: "error" });

export type PersonaParseResult = { ok: true; persona: PersonaDocument } | { ok: false; issue: string };

/**
 * Parses and validates the YAML text of a persona file. An empty file, or one with only comments, is
 * an empty persona. The issue text names the field, never the file's values.
 */
export function parsePersona(text: string): PersonaParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { maxAliasCount: 0, prettyErrors: true });
  } catch (cause) {
    const line = typeof cause === "object" && cause && "linePos" in cause ? lineOf(cause.linePos) : null;
    const code =
      typeof cause === "object" && cause && "code" in cause && typeof cause.code === "string" ? cause.code : null;
    const where = [code, line ? `line ${line}` : null].filter(Boolean).join(", ");
    return { ok: false, issue: where ? `The YAML is not valid (${where}).` : "The YAML is not valid." };
  }
  if (parsed === null || parsed === undefined) return { ok: true, persona: {} };
  const decoded = decodePersonaDocument(parsed);
  if (Result.isFailure(decoded)) return { ok: false, issue: decoded.failure.message.replace(/\s+/gu, " ").trim() };
  return { ok: true, persona: decoded.success };
}

function lineOf(linePos: unknown): number | null {
  if (!Array.isArray(linePos)) return null;
  const first = linePos[0];
  return isDynamicRecord(first) && typeof first.line === "number" ? first.line : null;
}

/** True when the persona sets nothing, so the prompt needs no persona block. */
export function personaIsEmpty(persona: PersonaDocument): boolean {
  return Object.entries(persona).every(
    ([key, value]) =>
      key === "version" ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0),
  );
}
