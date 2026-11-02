// Fork module (super-agent, roadmap item P.3). An agent reads and changes its own persona through
// OpenBot tools, with validation and a version for every change, instead of only editing the file.
// The Router has no file tools, so this is its only way to change its persona.
//
// An agent may add boundaries but never remove or reword one: a boundary is a limit that the owner
// set, and only the owner lifts it, by editing persona.yaml. A change that the schema refuses comes
// back with the field. A change applies from the agent's next session.

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { z } from "zod";
import { PersonaFileFailed, personaIo, personaTextHash, readPersonaText } from "../agent/persona/persona-file";
import { listPersonaVersions, snapshotPersona } from "../agent/persona/persona-history";
import { PERSONA_FILE_NAME, PERSONA_LIMITS, parsePersona } from "../agent/persona/persona-schema";
import { writeFileAtomically } from "../atomic-json-file";

export const PERSONA_TOOL_NAMES = ["persona_read", "persona_update"] as const;
export type PersonaToolName = (typeof PERSONA_TOOL_NAMES)[number];

export function isPersonaTool(name: string): name is PersonaToolName {
  return PERSONA_TOOL_NAMES.some((tool) => tool === name);
}

const updateShape = {
  yaml: z
    .string()
    .min(1)
    .max(PERSONA_LIMITS.fileBytes)
    .describe(
      "The whole new persona.yaml: role, goals, tone, boundaries, examples, routing_summary, channels, overrides.",
    ),
  expectedHash: z
    .string()
    .max(64)
    .optional()
    .describe("The hash that persona_read gave; the update is refused when the file changed since."),
};

export const PERSONA_TOOL_DEFINITIONS = [
  {
    name: "persona_read",
    description: "Read your persona.yaml: its text, the parsed fields, its version and hash, and any issue.",
    shape: {},
  },
  {
    name: "persona_update",
    description:
      "Replace your persona.yaml with a validated new version, when the user asks you to change your persona. You can add boundaries but not remove or reword one: only the owner lifts a boundary. Applies from your next session.",
    shape: updateShape,
  },
] as const;

const schemas = { persona_read: z.strictObject({}), persona_update: z.strictObject(updateShape) };

export type PersonaToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** The boundaries of the old text that the new text drops or rewords. */
export function removedBoundaries(oldText: string, newText: string): string[] {
  const before = parsePersona(oldText);
  const after = parsePersona(newText);
  if (!before.ok || !after.ok) return [];
  const kept = new Set(after.persona.boundaries ?? []);
  return (before.persona.boundaries ?? []).filter((boundary) => !kept.has(boundary));
}

export const handlePersonaTool = Effect.fn("PersonaTools.handle")(function* (
  workspace: string,
  tool: PersonaToolName,
  args: unknown,
): Effect.fn.Return<PersonaToolOutcome, PersonaFileFailed> {
  const parsed = schemas[tool].safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: `Invalid ${tool} input: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}.`,
    };
  const current = yield* readPersonaText(workspace).pipe(
    Effect.map((text) => ({ ok: true as const, text: Option.getOrElse(text, () => "") })),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        text: "",
        reason: error.cause === "outside" ? "persona.yaml links outside your workspace" : "persona.yaml cannot be read",
      }),
    ),
  );
  if (!current.ok) return { ok: false, error: `${current.reason}; the owner must fix the file.` };
  const versions = yield* listPersonaVersions(workspace);
  const hash = current.text ? personaTextHash(current.text) : null;
  if (tool === "persona_read") {
    const persona = current.text ? parsePersona(current.text) : null;
    return {
      ok: true,
      value: {
        exists: current.text.length > 0,
        hash,
        version: versions.findLast((entry) => entry.hash === hash)?.version ?? null,
        versions: versions.length,
        text: current.text,
        ...(persona ? (persona.ok ? { persona: persona.persona } : { issue: persona.issue }) : {}),
      },
    };
  }
  const input = schemas.persona_update.parse(args);
  if (input.expectedHash !== undefined && input.expectedHash !== (hash ?? ""))
    return { ok: false, error: "persona.yaml changed since you read it. Read it again with persona_read." };
  const next = input.yaml.endsWith("\n") ? input.yaml : `${input.yaml}\n`;
  const checked = parsePersona(next);
  if (!checked.ok) return { ok: false, error: `The new persona is not valid: ${checked.issue}` };
  const removed = removedBoundaries(current.text, next);
  if (removed.length > 0)
    return {
      ok: false,
      error: `You cannot remove or reword a boundary; only the owner lifts one by editing persona.yaml. Keep: ${removed.map((boundary) => JSON.stringify(boundary)).join(", ")}.`,
    };
  // A version of the text before the change, so a rollback can bring it back.
  if (current.text) yield* snapshotPersona(workspace, current.text);
  const root = yield* personaIo("write", () => realpath(workspace));
  yield* writeFileAtomically(join(root, PERSONA_FILE_NAME), next).pipe(
    Effect.mapError((error) => new PersonaFileFailed({ operation: "write", cause: error.cause })),
  );
  const saved = yield* snapshotPersona(workspace, next);
  return {
    ok: true,
    value: { version: saved.version, hash: saved.hash, note: "Saved. It applies from your next session." },
  };
});
