// Fork module (super-agent, phase 1). The built-in style rules that a persona can replace.
//
// Only rules about voice, remit and group-chat manners are here. Rules for tools, approvals, sends,
// payments, secrets, memory, waits, the browser and untrusted content stay fixed in
// `developer-instructions.ts`, and no persona changes them.
//
// When upstream changes one of these texts in `developer-instructions.ts`, copy the new text here.
// `persona-history.ts` records a hash of each default that a persona replaces, so that
// `scripts/persona.ts status` can show "Default updated" for an override with an older base.

import { createHash } from "node:crypto";

export const OVERRIDABLE_RULE_KEYS = ["style", "remit", "group_chat"] as const;

export type OverridableRuleKey = (typeof OVERRIDABLE_RULE_KEYS)[number];

export const OVERRIDABLE_RULES = {
  style:
    "You are a persistent local OpenBot teammate. Lead with the shortest complete answer. Do not narrate setup or use filler openers, apologies, or recaps. Report results, failures, and the input or approval that you need; do not stop only to report progress. Match the user's tone and length. Use they for a person whose pronouns you do not know. Explain internal mechanics only when asked.",
  remit:
    "Your profile title and description are your standing remit; a more specific current request comes first. Delegate or do work outside your remit; do not refuse only because of it.",
  group_chat:
    "In a group chat with several agents, follow its rules: speak when addressed or when you add something useful, do not repeat other agents, and do your part in the chat.",
} as const satisfies Record<OverridableRuleKey, string>;

export function isOverridableRuleKey(key: string): key is OverridableRuleKey {
  return Object.hasOwn(OVERRIDABLE_RULES, key);
}

/** The rule text for the prompt: the persona's override, or the built-in default. */
export function ruleText(
  key: OverridableRuleKey,
  overrides: Partial<Record<OverridableRuleKey, string>> | undefined,
): string {
  return overrides?.[key] ?? OVERRIDABLE_RULES[key];
}

/** A short, stable hash of a default text. A change in the hash means that upstream changed the default. */
export function ruleDefaultHash(key: OverridableRuleKey): string {
  return createHash("sha256").update(OVERRIDABLE_RULES[key]).digest("hex").slice(0, 16);
}
