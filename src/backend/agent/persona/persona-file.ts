// Fork module (super-agent, phase 1). Reads `persona.yaml` from an agent's workspace and the
// server-wide `global-instructions.md` from the OpenBot folder, for the prompt.
//
// A read never stops a session: a missing file gives no persona, and a file that cannot be read,
// is too large, or links outside the workspace gives an issue that the prompt states, so that the
// agent can tell the user.

import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import { isPathInside } from "../../path-containment";
import {
  PERSONA_FILE_NAME,
  PERSONA_LIMITS,
  type PersonaDocument,
  parsePersona,
  personaIsEmpty,
} from "./persona-schema";

export const GLOBAL_INSTRUCTIONS_FILE_NAME = "global-instructions.md";
/** Characters. Like an agent description, the text goes to every agent of the server. */
export const GLOBAL_INSTRUCTIONS_LIMIT = 8_000;

/** The native cause stays here; callers must not export it without redaction. */
export class PersonaFileFailed extends Schema.TaggedError<PersonaFileFailed>()("PersonaFileFailed", {
  operation: Schema.Literals(["read", "write"]),
  cause: Schema.Defect(),
}) {}

export const personaIo = <A>(operation: "read" | "write", run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PersonaFileFailed({ operation, cause }) });

const optionalIo = <A>(run: () => Promise<A>) => personaIo("read", run).pipe(Effect.option);

/** The persona as the prompt carries it. */
export interface PromptPersona {
  /** The raw file text, which the version history keeps. Empty when the file is refused. */
  text: string;
  /** A hash of `text`. It names the version in the history and in the session fingerprint. */
  hash: string;
  /** The valid persona, or null when the file has an issue. */
  persona: PersonaDocument | null;
  /** Why the file is ignored. The text names a field or a limit, never a value. */
  issue: string | null;
  /** The version number in the history, when the history recorded this text. */
  version?: number;
  /** The overridden built-in rules whose default changed after this version was saved (item P.6). */
  defaultUpdated?: string[];
}

export function personaTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** The real path of a regular file with this name at the root of `folder`, or none. */
const findRootFile = Effect.fn("PersonaFile.find")(function* (folder: string, fileName: string) {
  const root = yield* optionalIo(() => realpath(folder));
  if (Option.isNone(root)) return Option.none<{ path: string; size: number } | "outside">();
  const entry = yield* optionalIo(() => lstat(join(root.value, fileName)));
  if (Option.isNone(entry) || !(entry.value.isFile() || entry.value.isSymbolicLink()))
    return Option.none<{ path: string; size: number } | "outside">();
  const path = entry.value.isFile()
    ? Option.some(join(root.value, fileName))
    : yield* optionalIo(() => realpath(join(root.value, fileName)));
  if (Option.isNone(path)) return Option.none<{ path: string; size: number } | "outside">();
  if (!isPathInside(root.value, path.value)) return Option.some<"outside">("outside");
  const target = yield* optionalIo(() => lstat(path.value));
  if (Option.isNone(target) || !target.value.isFile()) return Option.none<{ path: string; size: number }>();
  return Option.some({ path: path.value, size: target.value.size });
});

const readStart = (path: string, size: number, limit: number) =>
  personaIo("read", async () => {
    const handle = await open(path, "r");
    try {
      const length = Math.min(size, limit);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  });

/** The raw text of `persona.yaml`, or none when the workspace has no such file. */
export const readPersonaText = Effect.fn("PersonaFile.readText")(function* (workspace: string) {
  const found = yield* findRootFile(workspace, PERSONA_FILE_NAME);
  if (Option.isNone(found)) return Option.none<string>();
  if (found.value === "outside") return yield* new PersonaFileFailed({ operation: "read", cause: "outside" });
  if (found.value.size > PERSONA_LIMITS.fileBytes)
    return yield* new PersonaFileFailed({ operation: "read", cause: "too-large" });
  return Option.some(yield* readStart(found.value.path, found.value.size, PERSONA_LIMITS.fileBytes));
});

/**
 * The persona for the prompt, or null when the workspace has no `persona.yaml` or the file sets
 * nothing. This never fails.
 */
export const promptPersona = Effect.fn("PersonaFile.prompt")(function* (workspace: string) {
  const found = yield* findRootFile(workspace, PERSONA_FILE_NAME).pipe(
    Effect.orElseSucceed(() => Option.none<{ path: string; size: number } | "outside">()),
  );
  if (Option.isNone(found)) return null;
  if (found.value === "outside")
    return refused("persona.yaml links to a place outside your workspace, so OpenBot ignores it.");
  if (found.value.size > PERSONA_LIMITS.fileBytes)
    return refused(`persona.yaml is larger than ${PERSONA_LIMITS.fileBytes} bytes, so OpenBot ignores it.`);
  const read = yield* readStart(found.value.path, found.value.size, PERSONA_LIMITS.fileBytes).pipe(Effect.option);
  if (Option.isNone(read)) return null;
  const text = read.value;
  const parsed = parsePersona(text);
  if (!parsed.ok)
    return { text, hash: personaTextHash(text), persona: null, issue: parsed.issue } satisfies PromptPersona;
  if (personaIsEmpty(parsed.persona)) return null;
  return { text, hash: personaTextHash(text), persona: parsed.persona, issue: null } satisfies PromptPersona;
});

function refused(issue: string): PromptPersona {
  return { text: "", hash: personaTextHash(issue), persona: null, issue };
}

/** The server-wide text for every agent, trimmed and cut at the limit. Empty when there is none. */
export const readGlobalInstructions = Effect.fn("PersonaFile.globalInstructions")(function* (openbotRoot: string) {
  const found = yield* findRootFile(openbotRoot, GLOBAL_INSTRUCTIONS_FILE_NAME).pipe(
    Effect.orElseSucceed(() => Option.none<{ path: string; size: number } | "outside">()),
  );
  if (Option.isNone(found) || found.value === "outside") return "";
  // A UTF-8 character takes at most 4 bytes.
  const read = yield* readStart(found.value.path, found.value.size, GLOBAL_INSTRUCTIONS_LIMIT * 4).pipe(
    Effect.orElseSucceed(() => ""),
  );
  return Array.from(read.trim()).slice(0, GLOBAL_INSTRUCTIONS_LIMIT).join("").trim();
});

/** What `ThreadLifecycle` adds to a session's instructions. */
export interface PersonaForPrompt {
  persona: PromptPersona | null;
  globalInstructions: string;
}

/**
 * The persona and the global instructions for a session start, with the persona's text recorded in
 * its version history. A history write that fails does not stop the session; the prompt then names
 * no version.
 */
export const personaForPrompt = Effect.fn("PersonaFile.forPrompt")(function* (
  workspace: string,
  openbotRoot: string,
  snapshot: (workspace: string, text: string) => Effect.Effect<{ version: number }, unknown>,
  staleDefaults?: (workspace: string) => Effect.Effect<readonly string[], unknown>,
) {
  const persona = yield* promptPersona(workspace);
  const globalInstructions = yield* readGlobalInstructions(openbotRoot);
  if (persona?.text) {
    const saved = yield* snapshot(workspace, persona.text).pipe(Effect.option);
    if (Option.isSome(saved)) persona.version = saved.value.version;
    if (staleDefaults) {
      const stale = yield* staleDefaults(workspace).pipe(Effect.orElseSucceed((): readonly string[] => []));
      if (stale.length > 0) persona.defaultUpdated = [...stale];
    }
  }
  return { persona, globalInstructions } satisfies PersonaForPrompt;
});
