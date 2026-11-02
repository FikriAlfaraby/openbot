// Fork tool (super-agent, phase 1). Checks an agent's persona.yaml and manages its version history.
//
//   bun scripts/persona.ts validate <file>
//   bun scripts/persona.ts status   <workspace>
//   bun scripts/persona.ts history  <workspace>
//   bun scripts/persona.ts show     <workspace> <version>
//   bun scripts/persona.ts snapshot <workspace>
//   bun scripts/persona.ts rollback <workspace> <version>
//
// <workspace> is the agent's folder, such as ~/OpenBot/Agents/<agent id>. A running session reads
// the new persona when its next session starts; a persona change starts a new provider session.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Option } from "effect";
import { OVERRIDABLE_RULE_KEYS } from "../src/backend/agent/persona/overridable-rules";
import { readPersonaText } from "../src/backend/agent/persona/persona-file";
import {
  listPersonaVersions,
  personaStatus,
  readPersonaVersion,
  rollbackPersona,
  snapshotPersona,
} from "../src/backend/agent/persona/persona-history";
import { parsePersona } from "../src/backend/agent/persona/persona-schema";

const USAGE = `Usage:
  bun scripts/persona.ts validate <file>
  bun scripts/persona.ts status   <workspace>
  bun scripts/persona.ts history  <workspace>
  bun scripts/persona.ts show     <workspace> <version>
  bun scripts/persona.ts snapshot <workspace>
  bun scripts/persona.ts rollback <workspace> <version>
Override keys: ${OVERRIDABLE_RULE_KEYS.join(", ")}
`;

const out = (text: string) => process.stdout.write(`${text}\n`);

function versionArgument(value: string | undefined): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new Error("The version must be a positive whole number.");
  return version;
}

const main = Effect.fn("PersonaCli.main")(function* (argv: readonly string[]) {
  const [command, target, extra] = argv;
  if (!command || !target) {
    process.stderr.write(USAGE);
    return 2;
  }
  const path = resolve(target);
  switch (command) {
    case "validate": {
      const parsed = parsePersona(yield* Effect.promise(() => readFile(path, "utf8")));
      out(parsed.ok ? "valid" : `invalid: ${parsed.issue}`);
      return parsed.ok ? 0 : 1;
    }
    case "status": {
      const status = yield* personaStatus(path);
      if (!status.current) out("No persona.yaml in this workspace.");
      else {
        out(
          `current: ${status.current.hash} (${status.current.version ? `version ${status.current.version}` : "not recorded yet"})`,
        );
        if (status.current.issue) out(`invalid: ${status.current.issue}`);
        for (const key of status.defaultUpdated)
          out(`Default updated: built-in rule "${key}" changed after this override.`);
      }
      out(`versions: ${status.versions.length}`);
      return 0;
    }
    case "history": {
      for (const entry of yield* listPersonaVersions(path))
        out(
          `${entry.version}\t${entry.hash}\t${entry.savedAt}${Object.keys(entry.overrideBases).length ? `\toverrides: ${Object.keys(entry.overrideBases).join(",")}` : ""}`,
        );
      return 0;
    }
    case "show": {
      const text = yield* readPersonaVersion(path, versionArgument(extra));
      if (Option.isNone(text)) {
        out("No such version.");
        return 1;
      }
      process.stdout.write(text.value);
      return 0;
    }
    case "snapshot": {
      const text = yield* readPersonaText(path);
      if (Option.isNone(text)) {
        out("No persona.yaml in this workspace.");
        return 1;
      }
      const saved = yield* snapshotPersona(path, text.value);
      out(saved.created ? `recorded version ${saved.version}` : `unchanged: version ${saved.version}`);
      return 0;
    }
    case "rollback": {
      const saved = yield* rollbackPersona(path, versionArgument(extra));
      if (Option.isNone(saved)) {
        out("No such version.");
        return 1;
      }
      out(`persona.yaml restored; recorded as version ${saved.value.version}`);
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return 2;
  }
});

if (import.meta.main) {
  Effect.runPromise(main(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
