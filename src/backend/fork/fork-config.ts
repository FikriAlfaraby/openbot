// Fork module (super-agent, roadmap item 2.2). The owner's host configuration: `fork-config.yaml`
// in the OpenBot folder (the parent of `Shared` and `Agents`).
//
// It names the role of each agent by its id. Roles change what the host allows an agent to do
// (item 2.3 and later), so the file lives outside every agent workspace: a Workspace-only agent
// can write only in its workspace, `Shared` and temporary folders, not here. A Full-access agent
// can write anywhere, so the roles hold only for agents that the owner keeps on Workspace only.
//
// A read never stops a session. A missing file means no roles. A file that cannot be read or is
// not valid keeps the last valid configuration of this process, so a bad edit does not drop the
// Router's limits; the issue is reported for the owner.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Result, Schema } from "effect";
import { parse as parseYaml } from "yaml";

export const FORK_CONFIG_FILE_NAME = "fork-config.yaml";
/** Bytes. The file names a few dozen agents at most. */
export const FORK_CONFIG_MAX_BYTES = 64_000;

export const FORK_ROLES = ["router", "worker", "watchdog"] as const;
export type ForkRole = (typeof FORK_ROLES)[number];

/** An OpenBot agent id: the name of its folder in `Agents`. */
const AgentId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u));

const AgentEntry = Schema.Struct({ role: Schema.Literals(FORK_ROLES) });

const ChatSettings = Schema.Struct({
  /** The most words of a Router reply in a chat channel (item 2.7). */
  maxWords: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 1_000 }))),
});

const ForkConfigDocument = Schema.Struct({
  version: Schema.Literal(1),
  agents: Schema.optionalKey(Schema.Record(AgentId, AgentEntry)),
  chat: Schema.optionalKey(ChatSettings),
});

export type ForkConfigDocument = typeof ForkConfigDocument.Type;

/** The configuration that the host uses. */
export interface ForkConfig {
  roles: ReadonlyMap<string, ForkRole>;
  /** The most words of a Router chat reply; null for the default. */
  chatMaxWords: number | null;
}

export const EMPTY_FORK_CONFIG: ForkConfig = { roles: new Map(), chatMaxWords: null };

const decodeDocument = Schema.decodeUnknownResult(ForkConfigDocument, { onExcessProperty: "error" });

export type ForkConfigParseResult = { ok: true; config: ForkConfig } | { ok: false; issue: string };

/** Parses and validates the YAML text. The issue names a field, never a value of the file. */
export function parseForkConfig(text: string): ForkConfigParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { maxAliasCount: 0, prettyErrors: true, uniqueKeys: true });
  } catch (cause) {
    const code = isDynamicRecord(cause) && typeof cause.code === "string" ? cause.code : null;
    return { ok: false, issue: code ? `The YAML is not valid (${code}).` : "The YAML is not valid." };
  }
  if (parsed === null || parsed === undefined) return { ok: true, config: EMPTY_FORK_CONFIG };
  const decoded = decodeDocument(parsed);
  if (Result.isFailure(decoded)) return { ok: false, issue: decoded.failure.message.replace(/\s+/gu, " ").trim() };
  const roles = new Map<string, ForkRole>();
  for (const [agentId, entry] of Object.entries(decoded.success.agents ?? {})) roles.set(agentId, entry.role);
  const routers = [...roles.values()].filter((role) => role === "router").length;
  if (routers > 1) return { ok: false, issue: "Only one agent can have the role router." };
  return { ok: true, config: { roles, chatMaxWords: decoded.success.chat?.maxWords ?? null } };
}

export interface ForkConfigState {
  config: ForkConfig;
  /** Why the file on disk is not used, or null when it is used or absent. */
  issue: string | null;
}

/**
 * Reads `fork-config.yaml` again only when its size or modification time changed. Synchronous,
 * because the tool router asks for a role on every tool call and the file is small.
 */
export class ForkConfigReader {
  readonly #path: string;
  #stamp: string | null = null;
  #state: ForkConfigState = { config: EMPTY_FORK_CONFIG, issue: null };
  /** The last valid configuration, kept when a later edit is not valid. */
  #lastValid: ForkConfig = EMPTY_FORK_CONFIG;

  constructor(openbotRoot: string) {
    this.#path = join(openbotRoot, FORK_CONFIG_FILE_NAME);
  }

  get path(): string {
    return this.#path;
  }

  /** The current state. A missing file is no roles; an invalid one keeps the last valid roles. */
  current(): ForkConfigState {
    let stamp: string;
    let size: number;
    try {
      const info = statSync(this.#path);
      if (!info.isFile()) return this.#set("missing", { config: EMPTY_FORK_CONFIG, issue: null });
      stamp = `${info.size}:${info.mtimeMs}`;
      size = info.size;
    } catch {
      return this.#set("missing", { config: EMPTY_FORK_CONFIG, issue: null });
    }
    if (stamp === this.#stamp) return this.#state;
    if (size > FORK_CONFIG_MAX_BYTES)
      return this.#set(stamp, {
        config: this.#lastValid,
        issue: `${FORK_CONFIG_FILE_NAME} is larger than ${FORK_CONFIG_MAX_BYTES} bytes.`,
      });
    return this.#readNow(stamp);
  }

  /** The role of an agent, or null when the configuration names none. */
  roleOf(agentId: string): ForkRole | null {
    return this.current().config.roles.get(agentId) ?? null;
  }

  #readNow(stamp: string): ForkConfigState {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch {
      return this.#set(stamp, { config: this.#lastValid, issue: `${FORK_CONFIG_FILE_NAME} cannot be read.` });
    }
    const parsed = parseForkConfig(text);
    if (!parsed.ok) return this.#set(stamp, { config: this.#lastValid, issue: parsed.issue });
    this.#lastValid = parsed.config;
    return this.#set(stamp, { config: parsed.config, issue: null });
  }

  #set(stamp: string, state: ForkConfigState): ForkConfigState {
    this.#stamp = stamp;
    this.#state = state;
    return state;
  }
}
