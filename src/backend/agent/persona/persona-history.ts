// Fork module (super-agent, phase 1). The version history of an agent's `persona.yaml`.
//
// Each text that OpenBot reads for a prompt becomes an immutable version in
// `<workspace>/.openbot-persona/versions/`, named `<number>-<hash>.yaml`, with a `.json` record
// beside it. A rollback writes an old version back to `persona.yaml`, which then becomes a new
// version: the history only grows. The record keeps a hash of each built-in rule that the version
// overrides, so that a later upstream change to that rule shows as "Default updated".

import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Option } from "effect";
import { writeFileAtomically } from "../../atomic-json-file";
import {
  isOverridableRuleKey,
  OVERRIDABLE_RULE_KEYS,
  type OverridableRuleKey,
  ruleDefaultHash,
} from "./overridable-rules";
import { PersonaFileFailed, personaIo, personaTextHash, readPersonaText } from "./persona-file";
import { PERSONA_FILE_NAME, parsePersona } from "./persona-schema";

export const PERSONA_HISTORY_FOLDER = join(".openbot-persona", "versions");

export interface PersonaVersion {
  version: number;
  hash: string;
  savedAt: string;
  /** The hash of each built-in default that this version overrides, when it was saved. */
  overrideBases: Partial<Record<OverridableRuleKey, string>>;
}

export interface PersonaStatus {
  /** The current file, or null when the workspace has no `persona.yaml`. */
  current: { hash: string; version: number | null; issue: string | null } | null;
  /** The override keys whose built-in default changed after the current version was saved. */
  defaultUpdated: OverridableRuleKey[];
  versions: PersonaVersion[];
}

const VERSION_NAME = /^(\d{6})-([0-9a-f]{12})\.yaml$/u;

const historyRoot = (workspace: string) => join(workspace, PERSONA_HISTORY_FOLDER);
const versionBase = (version: number, hash: string) => `${String(version).padStart(6, "0")}-${hash}`;

function overrideBases(text: string): PersonaVersion["overrideBases"] {
  const parsed = parsePersona(text);
  if (!parsed.ok || !parsed.persona.overrides) return {};
  const bases: PersonaVersion["overrideBases"] = {};
  for (const key of OVERRIDABLE_RULE_KEYS) if (parsed.persona.overrides[key]) bases[key] = ruleDefaultHash(key);
  return bases;
}

function decodeRecord(version: number, hash: string, raw: string | null): PersonaVersion {
  let savedAt = "";
  const bases: PersonaVersion["overrideBases"] = {};
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (isDynamicRecord(value)) {
      if (typeof value.savedAt === "string") savedAt = value.savedAt;
      if (isDynamicRecord(value.overrideBases))
        for (const [key, base] of Object.entries(value.overrideBases))
          if (isOverridableRuleKey(key) && typeof base === "string") bases[key] = base;
    }
  } catch {
    // A damaged record keeps the version; only its metadata is lost.
  }
  return { version, hash, savedAt, overrideBases: bases };
}

/** The versions, oldest first. */
export const listPersonaVersions = Effect.fn("PersonaHistory.list")(function* (workspace: string) {
  const root = historyRoot(workspace);
  const names = yield* personaIo("read", () => readdir(root)).pipe(Effect.orElseSucceed((): string[] => []));
  const versions: PersonaVersion[] = [];
  for (const name of names) {
    const match = VERSION_NAME.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    const hash = match[2] ?? "";
    const raw = yield* personaIo("read", () => readFile(join(root, `${versionBase(version, hash)}.json`), "utf8")).pipe(
      Effect.orElseSucceed(() => null),
    );
    versions.push(decodeRecord(version, hash, raw));
  }
  return versions.sort((a, b) => a.version - b.version);
});

/**
 * Records `text` as a new version unless the latest version has the same text. Two readers that
 * race for one number cannot overwrite each other: the version file is created exclusively.
 */
export const snapshotPersona = Effect.fn("PersonaHistory.snapshot")(function* (
  workspace: string,
  text: string,
  now: () => Date = () => new Date(),
) {
  const hash = personaTextHash(text);
  const root = historyRoot(workspace);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const versions = yield* listPersonaVersions(workspace);
    const latest = versions.at(-1);
    if (latest?.hash === hash) return { version: latest.version, hash, created: false };
    const version = (latest?.version ?? 0) + 1;
    const base = versionBase(version, hash);
    yield* personaIo("write", () => mkdir(root, { recursive: true, mode: 0o700 }));
    const created = yield* personaIo("write", () =>
      writeFile(join(root, `${base}.yaml`), text, { flag: "wx", mode: 0o600 }),
    ).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => isExists(error.cause),
        () => Effect.succeed(false),
      ),
    );
    if (!created) continue;
    const record = { savedAt: now().toISOString(), overrideBases: overrideBases(text) };
    yield* writeFileAtomically(join(root, `${base}.json`), `${JSON.stringify(record, null, 2)}\n`).pipe(
      Effect.mapError((error) => new PersonaFileFailed({ operation: "write", cause: error.cause })),
    );
    return { version, hash, created: true };
  }
  return yield* new PersonaFileFailed({ operation: "write", cause: "version-race" });
});

function isExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

/** The text of one version, or none when the history has no such version. */
export const readPersonaVersion = Effect.fn("PersonaHistory.read")(function* (workspace: string, version: number) {
  const found = (yield* listPersonaVersions(workspace)).find((entry) => entry.version === version);
  if (!found) return Option.none<string>();
  const text = yield* personaIo("read", () =>
    readFile(join(historyRoot(workspace), `${versionBase(found.version, found.hash)}.yaml`), "utf8"),
  );
  return Option.some(text);
});

/**
 * Writes an old version back to `persona.yaml` and records it as a new version. The current file
 * is recorded first, so that a rollback never loses an edit that no prompt read yet.
 */
export const rollbackPersona = Effect.fn("PersonaHistory.rollback")(function* (workspace: string, version: number) {
  const text = yield* readPersonaVersion(workspace, version);
  if (Option.isNone(text)) return Option.none<{ version: number; hash: string; created: boolean }>();
  const current = yield* readPersonaText(workspace);
  if (Option.isSome(current)) yield* snapshotPersona(workspace, current.value);
  const root = yield* personaIo("write", () => realpath(workspace));
  yield* writeFileAtomically(join(root, PERSONA_FILE_NAME), text.value).pipe(
    Effect.mapError((error) => new PersonaFileFailed({ operation: "write", cause: error.cause })),
  );
  return Option.some(yield* snapshotPersona(workspace, text.value));
});

/** The overridden built-in rules of the current file whose default changed since it was saved. */
export const staleOverrides = Effect.fn("PersonaHistory.staleOverrides")(function* (workspace: string) {
  return (yield* personaStatus(workspace)).defaultUpdated;
});

/** The current file, its version, and the overrides whose built-in default changed since. */
export const personaStatus = Effect.fn("PersonaHistory.status")(function* (workspace: string) {
  const versions = yield* listPersonaVersions(workspace);
  const text = yield* readPersonaText(workspace).pipe(Effect.orElseSucceed(() => Option.none<string>()));
  if (Option.isNone(text)) return { current: null, defaultUpdated: [], versions } satisfies PersonaStatus;
  const hash = personaTextHash(text.value);
  const parsed = parsePersona(text.value);
  const recorded = versions.findLast((entry) => entry.hash === hash);
  const bases = recorded?.overrideBases ?? overrideBases(text.value);
  const defaultUpdated = OVERRIDABLE_RULE_KEYS.filter((key) => bases[key] && bases[key] !== ruleDefaultHash(key));
  return {
    current: { hash, version: recorded?.version ?? null, issue: parsed.ok ? null : parsed.issue },
    defaultUpdated,
    versions,
  } satisfies PersonaStatus;
});
