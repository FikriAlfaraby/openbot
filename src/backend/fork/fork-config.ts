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
import type { PlatformGate } from "./gate";

export const FORK_CONFIG_FILE_NAME = "fork-config.yaml";
/** Bytes. The file names a few dozen agents at most. */
export const FORK_CONFIG_MAX_BYTES = 64_000;

const FORK_ROLES = ["router", "worker", "watchdog"] as const;
export type ForkRole = (typeof FORK_ROLES)[number];

/** An OpenBot agent id: the name of its folder in `Agents`. */
const AgentId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u));

/** A daily budget (item 4.2): the most tokens and estimated dollars in 24 hours. */
const DailyTokens = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 1_000_000_000 }));
const DailyUsd = Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 100_000 }));

const AgentEntry = Schema.Struct({
  role: Schema.optionalKey(Schema.Literals(FORK_ROLES)),
  dailyTokens: Schema.optionalKey(DailyTokens),
  dailyUsd: Schema.optionalKey(DailyUsd),
});

/** The fork's storage housekeeping (item 4.4). */
const StorageSettings = Schema.Struct({
  archiveAfterDays: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_650 }))),
});

const BudgetSettings = Schema.Struct({
  dailyTokens: Schema.optionalKey(DailyTokens),
  dailyUsd: Schema.optionalKey(DailyUsd),
});

const ChatSettings = Schema.Struct({
  /** The most words of a Router reply in a chat channel (item 2.7). */
  maxWords: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 1_000 }))),
  /** The language of the host's own chat replies, such as `/tiket` (item 5.2). */
  commandLanguage: Schema.optionalKey(Schema.Literals(["id", "en"])),
});

const PlainText = (max: number) => Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(max));

/** T3 Code, the coding executor (item 3.1b, docs/fork/t3.md). */
const T3Settings = Schema.Struct({
  /** The command and its first arguments, such as [t3] or [sudo, -u, t3, t3]. */
  command: Schema.optionalKey(Schema.Array(PlainText(512)).check(Schema.isMinLength(1), Schema.isMaxLength(8))),
  /** T3 Code's home folder, for --base-dir. */
  baseDir: Schema.optionalKey(PlainText(1_024)),
  /** The project: a T3 project id or a path inside it. */
  project: Schema.optionalKey(PlainText(1_024)),
  /** The branch that a new ticket's worktree starts from. */
  baseBranch: Schema.optionalKey(PlainText(200)),
  /** How long one t3_run waits for the run before it reports that the run goes on. */
  waitSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3_600 }))),
});

/** Which agents get an MCP server (item 3.1d). The key is the server's name in OpenBot. */
const McpAccess = Schema.Struct({
  agents: Schema.Array(AgentId).check(Schema.isMaxLength(64)),
});

/** The gate of one chat platform (item 3.3). */
const PlatformGateEntry = Schema.Struct({
  mode: Schema.Literals(["off", "observe", "auto"]),
  allow: Schema.optionalKey(Schema.Array(PlainText(64)).check(Schema.isMaxLength(500))),
});

/** The Watchdog's schedule (item 4.1). */
const WatchdogSettings = Schema.Struct({
  everyMinutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 1_440 }))),
  staleMinutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 10_080 }))),
});

const ForkConfigDocument = Schema.Struct({
  version: Schema.Literal(1),
  watchdog: Schema.optionalKey(WatchdogSettings),
  budget: Schema.optionalKey(BudgetSettings),
  storage: Schema.optionalKey(StorageSettings),
  gate: Schema.optionalKey(
    Schema.Struct({
      telegram: Schema.optionalKey(PlatformGateEntry),
      slack: Schema.optionalKey(PlatformGateEntry),
      discord: Schema.optionalKey(PlatformGateEntry),
    }),
  ),
  agents: Schema.optionalKey(Schema.Record(AgentId, AgentEntry)),
  chat: Schema.optionalKey(ChatSettings),
  t3: Schema.optionalKey(T3Settings),
  mcp: Schema.optionalKey(Schema.Record(PlainText(128), McpAccess)),
});

export type ForkT3Settings = typeof T3Settings.Type;

/** The configuration that the host uses. */
export interface ForkConfig {
  roles: ReadonlyMap<string, ForkRole>;
  /** The most words of a Router chat reply; null for the default. */
  chatMaxWords: number | null;
  /** The language of the host's chat command replies; null for Indonesian (item 5.2). */
  commandLanguage: "id" | "en" | null;
  /** T3 Code settings; null when the file names none. */
  t3: ForkT3Settings | null;
  /** The agents of each MCP server that the file limits, by server name. Other servers go to all. */
  mcpAgents: ReadonlyMap<string, ReadonlySet<string>>;
  /** The gate of each chat platform that the file names (item 3.3). */
  gates: ReadonlyMap<string, PlatformGate>;
  /** The Watchdog's schedule; null for the defaults (item 4.1). */
  watchdog: { everyMinutes?: number; staleMinutes?: number } | null;
  /** The budget of every agent without its own (item 4.2); null for none. */
  budget: { dailyTokens?: number; dailyUsd?: number } | null;
  /** The budgets that the file sets for one agent, by agent id. */
  agentBudgets: ReadonlyMap<string, { dailyTokens?: number; dailyUsd?: number }>;
  /** Days after its end before a ticket moves to the archive (item 4.4); null for the default. */
  archiveAfterDays: number | null;
}

const EMPTY_FORK_CONFIG: ForkConfig = {
  roles: new Map(),
  chatMaxWords: null,
  commandLanguage: null,
  t3: null,
  mcpAgents: new Map(),
  gates: new Map(),
  watchdog: null,
  budget: null,
  agentBudgets: new Map(),
  archiveAfterDays: null,
};

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
  const agentBudgets = new Map<string, { dailyTokens?: number; dailyUsd?: number }>();
  for (const [agentId, entry] of Object.entries(decoded.success.agents ?? {})) {
    if (entry.role) roles.set(agentId, entry.role);
    if (entry.dailyTokens !== undefined || entry.dailyUsd !== undefined)
      agentBudgets.set(agentId, {
        ...(entry.dailyTokens !== undefined ? { dailyTokens: entry.dailyTokens } : {}),
        ...(entry.dailyUsd !== undefined ? { dailyUsd: entry.dailyUsd } : {}),
      });
  }
  const routers = [...roles.values()].filter((role) => role === "router").length;
  if (routers > 1) return { ok: false, issue: "Only one agent can have the role router." };
  return {
    ok: true,
    config: {
      roles,
      chatMaxWords: decoded.success.chat?.maxWords ?? null,
      commandLanguage: decoded.success.chat?.commandLanguage ?? null,
      t3: decoded.success.t3 ?? null,
      mcpAgents: new Map(
        Object.entries(decoded.success.mcp ?? {}).map(([name, access]) => [name, new Set(access.agents)]),
      ),
      watchdog: decoded.success.watchdog ?? null,
      budget: decoded.success.budget ?? null,
      archiveAfterDays: decoded.success.storage?.archiveAfterDays ?? null,
      agentBudgets,
      gates: new Map(
        Object.entries(decoded.success.gate ?? {}).map(([platform, entry]) => [
          platform,
          { mode: entry.mode, allow: entry.allow ? new Set(entry.allow) : null },
        ]),
      ),
    },
  };
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
