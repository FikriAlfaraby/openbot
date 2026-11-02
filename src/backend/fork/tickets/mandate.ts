// Fork module (super-agent, roadmap item 3.4). The mandate of a ticket, after the DeepSeek prototype
// (`docs/001-domain.md`): what an accepted request grants, recorded by the host when the ticket is
// created, never by a model, and immutable afterwards. The host checks it again before a ticket
// resumes and before risky work (`t3_run`): a sender that the gate no longer allows revokes it. Chat
// text cannot change a mandate.

import { createHash } from "node:crypto";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { PlatformGate } from "../gate";

export const MANDATE_STRENGTHS = ["explicit", "open", "agent"] as const;
/**
 * - `explicit`: a person on the gate's allow-list asked for the work.
 * - `open`: a person asked, and the platform has no allow-list (upstream's behavior).
 * - `agent`: no person's message started it (the app, a routine, a teammate).
 */
export type MandateStrength = (typeof MANDATE_STRENGTHS)[number];

export interface Mandate {
  version: 1;
  strength: MandateStrength;
  /** What the work may cover, in the Router's words; a wider scope needs a new ticket. */
  scope: string;
  sender: { platform: string; authorId: string } | null;
  /** A hash of the platform's gate when the ticket was made. */
  policyVersion: string;
  grantedAt: string;
}

export interface MandateOrigin {
  sender: { platform: string; authorId: string } | null;
}

function gateHash(gate: PlatformGate | null): string {
  const value = gate ? { mode: gate.mode, allow: gate.allow ? [...gate.allow].sort() : null } : null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function buildMandate(
  origin: MandateOrigin,
  gate: PlatformGate | null,
  scope: string,
  now: () => Date = () => new Date(),
): Mandate {
  const strength: MandateStrength = !origin.sender
    ? "agent"
    : gate?.allow?.has(origin.sender.authorId)
      ? "explicit"
      : "open";
  return {
    version: 1,
    strength,
    scope: scope.trim().slice(0, 500),
    sender: origin.sender,
    policyVersion: gateHash(gate),
    grantedAt: now().toISOString(),
  };
}

export function parseMandate(json: string | null): Mandate | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    if (!isDynamicRecord(value) || value.version !== 1 || typeof value.strength !== "string") return null;
    const strength = MANDATE_STRENGTHS.find((item) => item === value.strength);
    if (!strength) return null;
    const sender =
      isDynamicRecord(value.sender) &&
      typeof value.sender.platform === "string" &&
      typeof value.sender.authorId === "string"
        ? { platform: value.sender.platform, authorId: value.sender.authorId }
        : null;
    return {
      version: 1,
      strength,
      scope: typeof value.scope === "string" ? value.scope : "",
      sender,
      policyVersion: typeof value.policyVersion === "string" ? value.policyVersion : "",
      grantedAt: typeof value.grantedAt === "string" ? value.grantedAt : "",
    };
  } catch {
    return null;
  }
}

export type MandateCheck = { ok: true; policyChanged: boolean } | { ok: false; reason: string };

/**
 * Whether a mandate still holds under the platform's gate now. A ticket without a mandate (made
 * before item 3.4) holds. An agent mandate holds. A person's mandate holds while the gate is not
 * off and still lets the sender give work.
 */
export function mandateHolds(
  mandateJson: string | null,
  gateNow: (platform: string) => PlatformGate | null,
): MandateCheck {
  const mandate = parseMandate(mandateJson);
  if (!mandate || mandate.strength === "agent" || !mandate.sender) return { ok: true, policyChanged: false };
  const gate = gateNow(mandate.sender.platform);
  const changed = gateHash(gate) !== mandate.policyVersion;
  if (gate?.mode === "off") return { ok: false, reason: `the ${mandate.sender.platform} gate is off now` };
  if (gate?.allow && !gate.allow.has(mandate.sender.authorId))
    return { ok: false, reason: "the person who asked for this work is no longer on the gate's allow-list" };
  return { ok: true, policyChanged: changed };
}
