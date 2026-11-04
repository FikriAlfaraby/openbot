// Fork module (docs/fork/travel-handover.md). Travel handover: a server keeps a copy of a computer's
// chats, and one side at a time owns each chat, so it never splits in two.
//
// Both sides keep their state in `fork-handover.db`, a SQLite file of its own beside `openbot.db`, not
// in a migration of `openbot.db` (the reason `fork-tickets.db` gives). The computer that sends the
// copies keeps `outgoing_agents`; the server that keeps them keeps `incoming_agents`. One file holds
// both, so a host can be either.
//
// Owner: `source` while the computer's chat is the live one, `copy` once a person continued the
// chat on the server. The server decides the owner of its copy; the computer follows it.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  checkedColumn,
  databaseRow,
  databaseRows,
  optionalNumberColumn,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../../database/database-rows";

export const HANDOVER_DATABASE_FILE_NAME = "fork-handover.db";

const OWNERS = ["source", "copy"] as const;
export type HandoverOwner = (typeof OWNERS)[number];

/** One agent of this computer that a server keeps a copy of. */
export interface OutgoingAgent {
  serverId: string;
  /** The server's name in the server list, for the lock notice. */
  serverName: string;
  localAgentId: string;
  /** The copy on the server; null until the copy is made. */
  remoteAgentId: string | null;
  /** Whether the server recorded the copy as this agent's. */
  registered: boolean;
  /** The chat whose messages went to the copy, and the last event sequence that went. */
  localThreadId: string | null;
  cursor: number;
  owner: HandoverOwner;
  changedAt: string;
}

/** One agent of this server that is the copy of an agent on a computer. */
export interface IncomingAgent {
  sourceServerId: string;
  sourceAgentId: string;
  agentId: string;
  /** The copy's chat; null until the first messages arrive. */
  threadId: string | null;
  owner: HandoverOwner;
  /** The chat's last event sequence when a person took it over; the messages after it are the server's. */
  takeoverSequence: number | null;
  changedAt: string;
}

export class HandoverError extends Error {
  constructor(
    readonly code: "not-found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

const SCHEMA_VERSION = 1;

const OWNER_CHECK = OWNERS.map((owner) => `'${owner}'`).join(", ");
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS outgoing_agents (
    server_id TEXT NOT NULL,
    server_name TEXT NOT NULL DEFAULT '',
    local_agent_id TEXT NOT NULL,
    remote_agent_id TEXT,
    registered INTEGER NOT NULL DEFAULT 0 CHECK (registered IN (0, 1)),
    local_thread_id TEXT,
    cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    owner TEXT NOT NULL DEFAULT 'source' CHECK (owner IN (${OWNER_CHECK})),
    changed_at TEXT NOT NULL,
    PRIMARY KEY (server_id, local_agent_id)
  );
  CREATE INDEX IF NOT EXISTS outgoing_agents_local ON outgoing_agents (local_agent_id);
  CREATE TABLE IF NOT EXISTS incoming_agents (
    source_server_id TEXT NOT NULL,
    source_agent_id TEXT NOT NULL,
    agent_id TEXT NOT NULL UNIQUE,
    thread_id TEXT,
    owner TEXT NOT NULL DEFAULT 'source' CHECK (owner IN (${OWNER_CHECK})),
    takeover_sequence INTEGER,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (source_server_id, source_agent_id)
  );
  CREATE INDEX IF NOT EXISTS incoming_agents_thread ON incoming_agents (thread_id) WHERE thread_id IS NOT NULL;
`;

function outgoingOf(row: DynamicRecord): OutgoingAgent {
  return {
    serverId: requiredStringColumn(row, "server_id"),
    serverName: requiredStringColumn(row, "server_name"),
    localAgentId: requiredStringColumn(row, "local_agent_id"),
    remoteAgentId: optionalStringColumn(row, "remote_agent_id"),
    registered: requiredNumberColumn(row, "registered") === 1,
    localThreadId: optionalStringColumn(row, "local_thread_id"),
    cursor: requiredNumberColumn(row, "cursor"),
    owner: checkedColumn(row, "owner", OWNERS),
    changedAt: requiredStringColumn(row, "changed_at"),
  };
}

function incomingOf(row: DynamicRecord): IncomingAgent {
  return {
    sourceServerId: requiredStringColumn(row, "source_server_id"),
    sourceAgentId: requiredStringColumn(row, "source_agent_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    threadId: optionalStringColumn(row, "thread_id"),
    owner: checkedColumn(row, "owner", OWNERS),
    takeoverSequence: optionalNumberColumn(row, "takeover_sequence"),
    changedAt: requiredStringColumn(row, "changed_at"),
  };
}

export interface HandoverStoreOptions {
  /** The folder of `openbot.db`; the handover file goes beside it. */
  userDataPath: string;
  now?: () => Date;
}

const stores = new Map<string, HandoverStore>();

/** One store per user data folder for the process, opened at first use. */
export function handoverStoreFor(userDataPath: string): HandoverStore {
  let store = stores.get(userDataPath);
  if (!store) {
    store = new HandoverStore({ userDataPath });
    stores.set(userDataPath, store);
  }
  return store;
}

/** Owns `fork-handover.db`. It never imports the `openbot.db` facade. */
export class HandoverStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(options: HandoverStoreOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#db = new DatabaseSync(join(options.userDataPath, HANDOVER_DATABASE_FILE_NAME));
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #migrate(): void {
    const row = databaseRow(this.#db.prepare("PRAGMA user_version").get());
    const version = row ? requiredNumberColumn(row, "user_version") : 0;
    if (version > SCHEMA_VERSION)
      throw new HandoverError(
        "invalid",
        `${HANDOVER_DATABASE_FILE_NAME} has schema ${version}, newer than this build.`,
      );
    if (version === SCHEMA_VERSION) return;
    this.#transaction(() => {
      this.#db.exec(SCHEMA_SQL);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  #transaction<A>(run: () => A): A {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  // The computer's side.

  outgoing(serverId: string, localAgentId: string): OutgoingAgent | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM outgoing_agents WHERE server_id = ? AND local_agent_id = ?")
        .get(serverId, localAgentId),
    );
    return row ? outgoingOf(row) : null;
  }

  listOutgoing(serverId: string): OutgoingAgent[] {
    return databaseRows(
      this.#db.prepare("SELECT * FROM outgoing_agents WHERE server_id = ? ORDER BY local_agent_id").all(serverId),
    ).map(outgoingOf);
  }

  /** The agent's copy that a person continued on a server, or null when this computer owns the chat. */
  lockedOutgoing(localAgentId: string): OutgoingAgent | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM outgoing_agents WHERE local_agent_id = ? AND owner = 'copy' LIMIT 1")
        .get(localAgentId),
    );
    return row ? outgoingOf(row) : null;
  }

  /** Records the copy that the server made. The server has not recorded it as this agent's yet. */
  recordCopy(serverId: string, localAgentId: string, remoteAgentId: string, serverName = ""): OutgoingAgent {
    this.#db
      .prepare(
        `INSERT INTO outgoing_agents (server_id, server_name, local_agent_id, remote_agent_id, changed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (server_id, local_agent_id) DO UPDATE SET
           server_name = excluded.server_name, remote_agent_id = excluded.remote_agent_id, registered = 0,
           local_thread_id = NULL, cursor = 0, owner = 'source', changed_at = excluded.changed_at`,
      )
      .run(serverId, serverName, localAgentId, remoteAgentId, this.#stamp());
    return this.#requireOutgoing(serverId, localAgentId);
  }

  /** Keeps the server's name as the server list shows it now. */
  renameServer(serverId: string, serverName: string): void {
    this.#db
      .prepare("UPDATE outgoing_agents SET server_name = ? WHERE server_id = ? AND server_name != ?")
      .run(serverName, serverId, serverName);
  }

  markRegistered(serverId: string, localAgentId: string): void {
    this.#updateOutgoing(serverId, localAgentId, "registered = 1");
  }

  /** The messages of `threadId` up to `cursor` are on the server. A new chat starts from zero. */
  advance(serverId: string, localAgentId: string, threadId: string, cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HandoverError("invalid", "A cursor is a count.");
    this.#updateOutgoing(serverId, localAgentId, "local_thread_id = ?, cursor = ?", threadId, cursor);
  }

  setOutgoingOwner(serverId: string, localAgentId: string, owner: HandoverOwner): void {
    this.#updateOutgoing(serverId, localAgentId, "owner = ?", owner);
  }

  /** The server lost the copy: the next round makes a new one. */
  forgetOutgoing(serverId: string, localAgentId: string): void {
    this.#db
      .prepare("DELETE FROM outgoing_agents WHERE server_id = ? AND local_agent_id = ?")
      .run(serverId, localAgentId);
  }

  #updateOutgoing(serverId: string, localAgentId: string, assignments: string, ...values: (string | number)[]): void {
    const result = this.#db
      .prepare(`UPDATE outgoing_agents SET ${assignments}, changed_at = ? WHERE server_id = ? AND local_agent_id = ?`)
      .run(...values, this.#stamp(), serverId, localAgentId);
    if (result.changes !== 1) throw new HandoverError("not-found", `No copy is recorded for agent ${localAgentId}.`);
  }

  #requireOutgoing(serverId: string, localAgentId: string): OutgoingAgent {
    const found = this.outgoing(serverId, localAgentId);
    if (!found) throw new HandoverError("not-found", `No copy is recorded for agent ${localAgentId}.`);
    return found;
  }

  // The server's side.

  incomingBySource(sourceServerId: string, sourceAgentId: string): IncomingAgent | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM incoming_agents WHERE source_server_id = ? AND source_agent_id = ?")
        .get(sourceServerId, sourceAgentId),
    );
    return row ? incomingOf(row) : null;
  }

  incomingByAgent(agentId: string): IncomingAgent | null {
    const row = databaseRow(this.#db.prepare("SELECT * FROM incoming_agents WHERE agent_id = ?").get(agentId));
    return row ? incomingOf(row) : null;
  }

  /** Whether `threadId` is the chat of a copy. Its first session then gets the copied history. */
  isCopyThread(threadId: string): boolean {
    return (
      databaseRow(this.#db.prepare("SELECT 1 AS found FROM incoming_agents WHERE thread_id = ?").get(threadId)) !== null
    );
  }

  /**
   * Records `agentId` as the copy of the computer's agent. Recording the same pair again is a no-op;
   * another agent for the same source, or a second source for the same agent, is a conflict.
   */
  registerIncoming(sourceServerId: string, sourceAgentId: string, agentId: string): IncomingAgent {
    return this.#transaction(() => {
      const existing = this.incomingBySource(sourceServerId, sourceAgentId);
      if (existing?.agentId === agentId) return existing;
      const taken = this.incomingByAgent(agentId);
      if (taken) throw new HandoverError("conflict", `Agent ${agentId} is already the copy of another agent.`);
      // The copy that this source had before is gone or replaced: the new one takes its place.
      if (existing)
        this.#db
          .prepare("DELETE FROM incoming_agents WHERE source_server_id = ? AND source_agent_id = ?")
          .run(sourceServerId, sourceAgentId);
      this.#db
        .prepare(
          "INSERT INTO incoming_agents (source_server_id, source_agent_id, agent_id, changed_at) VALUES (?, ?, ?, ?)",
        )
        .run(sourceServerId, sourceAgentId, agentId, this.#stamp());
      const created = this.incomingByAgent(agentId);
      if (!created) throw new HandoverError("not-found", `Agent ${agentId} was not recorded.`);
      return created;
    });
  }

  setIncomingThread(agentId: string, threadId: string): void {
    this.#updateIncoming(agentId, "thread_id = ?", threadId);
  }

  /**
   * A person wrote in the copy: the server owns the chat from now on. Returns false when it owned it
   * already, so the first message alone sets the sequence.
   */
  takeOver(agentId: string, sequence: number): boolean {
    const result = this.#db
      .prepare(
        "UPDATE incoming_agents SET owner = 'copy', takeover_sequence = ?, changed_at = ? WHERE agent_id = ? AND owner = 'source'",
      )
      .run(sequence, this.#stamp(), agentId);
    return result.changes === 1;
  }

  /** The computer took the chat back: the copy follows it again. */
  release(agentId: string): void {
    this.#updateIncoming(agentId, "owner = 'source', takeover_sequence = NULL");
  }

  #updateIncoming(agentId: string, assignments: string, ...values: string[]): void {
    const result = this.#db
      .prepare(`UPDATE incoming_agents SET ${assignments}, changed_at = ? WHERE agent_id = ?`)
      .run(...values, this.#stamp(), agentId);
    if (result.changes !== 1) throw new HandoverError("not-found", `Agent ${agentId} is not a copy.`);
  }
}
