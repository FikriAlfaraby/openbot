// Fork module (docs/fork/travel-handover.md). The computer's side of travel handover: it keeps a copy
// of each chosen agent's own chat on one server, reads which chats a person continued there, and
// brings a chat back on request.
//
// One round at a time. A round reads the owner of every copy first, so a chat that a person took over
// on the server locks here before anything else is sent. A server that cannot be reached ends the
// round quietly: the next round, or the next turn, tries again.

import { type ConversationMessage, isConversationMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  TRAVEL_HANDOVER_AGENTS,
  TRAVEL_HANDOVER_BUSY,
  TRAVEL_HANDOVER_NOT_REGISTERED,
  TRAVEL_HANDOVER_ROUTES,
  TRAVEL_HANDOVER_TAKEN_OVER,
} from "@openbot/contracts/team-protocol/fork-travel-handover-v1";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import type { ForkHandoverSettings } from "../../../backend/fork/fork-config";
import type { HandoverChat } from "../../../backend/fork/handover/handover-conversation";
import { readChatChanges } from "../../../backend/fork/handover/handover-messages";
import {
  type HandoverOwner,
  type HandoverStore,
  handoverStoreFor,
  type OutgoingAgent,
} from "../../../backend/fork/handover/handover-store";
import { RemoteRequestError } from "../../remote-server-errors";

const logger = createOpenBotLogger("travel-handover");

/** How often a round runs when the file names no interval. */
const HANDOVER_DEFAULT_MINUTES = 3;
/** How long after a finished turn the copy is brought up to date. */
const TURN_DELAY_MS = 5_000;
/** The most pushes of one agent in one round, so a long first copy does not hold the others. */
const PUSHES_PER_ROUND = 10;

export interface HandoverServerEntry {
  id: string;
  name: string;
  kind: "local" | "remote";
  state: string;
}

/** The body of a travel-handover call (`fork-travel-handover-v1`): its route reads the fields it needs. */
export interface HandoverCallBody {
  sourceServerId: string;
  sourceAgentId?: string;
  agentId?: string | null;
  agentIds?: readonly string[];
  messages?: readonly ConversationMessage[];
  after?: number;
}

/** The joined servers and the calls to them. */
export interface HandoverRemote {
  servers(): readonly HandoverServerEntry[];
  /** A travel-handover call; a refusal throws a `RemoteRequestError` with the server's status. */
  call(serverId: string, path: string, body: HandoverCallBody): Promise<unknown>;
  /** Makes a copy of the agent on the server, without files, and answers the copy's id. */
  copyAgent(serverId: string, agentId: string): Promise<string>;
}

export interface HandoverSyncOptions {
  conversation: HandoverChat;
  remote: HandoverRemote;
  /** This computer's server id: the source of every copy. */
  localServerId: () => string | null;
  settings: () => ForkHandoverSettings | null;
  store?: HandoverStore;
}

/** One agent as the lock notice reads it. */
export interface HandoverAgentState {
  agentId: string;
  serverId: string;
  serverName: string;
  owner: HandoverOwner;
}

export class HandoverSync {
  readonly #conversation: HandoverChat;
  readonly #remote: HandoverRemote;
  readonly #localServerId: () => string | null;
  readonly #settings: () => ForkHandoverSettings | null;
  readonly #store: HandoverStore;
  readonly #listeners = new Set<() => void>();
  #running: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #turnTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `stop`: a round in progress ends, and no timer starts again. */
  #stopped = false;

  constructor(options: HandoverSyncOptions) {
    this.#conversation = options.conversation;
    this.#remote = options.remote;
    this.#localServerId = options.localServerId;
    this.#settings = options.settings;
    this.#store = options.store ?? handoverStoreFor(options.conversation.userDataPath);
  }

  start(): void {
    this.#stopped = false;
    this.#schedule(10_000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#timer = null;
    this.#turnTimer = null;
  }

  /** Calls `listener` when an agent locks or unlocks. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A turn of `agentId` ended: its copy follows a few seconds later. */
  turnEnded(agentId: string): void {
    if (this.#stopped || !this.#chosen(agentId)) return;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#turnTimer = setTimeout(() => {
      this.#turnTimer = null;
      void this.round();
    }, TURN_DELAY_MS);
  }

  /** The agents whose copy a server keeps, with their owner. */
  states(): HandoverAgentState[] {
    const server = this.#server();
    if (!server) return [];
    return this.#store.listOutgoing(server.id).map((row) => ({
      agentId: row.localAgentId,
      serverId: row.serverId,
      serverName: row.serverName || server.name,
      owner: row.owner,
    }));
  }

  /** Runs a round now, or once more after the running one. */
  round(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#roundNow()
      .catch((error: unknown) => logger.warn("A travel handover round failed.", { message: messageOf(error) }))
      .finally(() => {
        this.#running = null;
        if (this.#again) {
          this.#again = false;
          void this.round();
        } else this.#schedule();
      });
    return this.#running;
  }

  /**
   * Brings the agent's chat back from the server: the messages a person wrote there go into the chat
   * here, the server's copy follows this chat again, and the next turn here reads them.
   */
  async bringBack(agentId: string): Promise<void> {
    const row = this.#store.lockedOutgoing(agentId);
    if (!row) return;
    const sourceServerId = this.#requireLocalServerId();
    const server = this.#remote.servers().find((candidate) => candidate.id === row.serverId);
    const name = row.serverName || server?.name || row.serverId;
    if (server?.state !== "online") throw new Error(sourceText("error.agent.handoverUnavailable", { server: name }));
    const source = { sourceServerId, sourceAgentId: agentId };
    let after = 0;
    for (;;) {
      const page = decodePull(await this.#remote.call(row.serverId, TRAVEL_HANDOVER_ROUTES.pull, { ...source, after }));
      if (page.messages.length > 0) this.#conversation.writeMainChat(agentId, page.messages);
      after = page.lastSequence;
      if (!page.more) break;
    }
    try {
      await this.#remote.call(row.serverId, TRAVEL_HANDOVER_ROUTES.release, source);
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === TRAVEL_HANDOVER_BUSY)
        throw new Error(sourceText("error.agent.handoverBusy", { server: name }));
      throw error;
    }
    // The cursor stays: an answer that finished here during the takeover still goes to the copy, and
    // what came back goes with it as the same messages the copy has.
    this.#store.setOutgoingOwner(row.serverId, agentId, "source");
    await this.#conversation.endContext(agentId);
    this.#changed();
  }

  async #roundNow(): Promise<void> {
    const server = this.#server();
    const sourceServerId = this.#localServerId();
    if (!server || !sourceServerId || server.state !== "online") return;
    this.#store.renameServer(server.id, server.name);
    const chosen = this.#conversation.agents().filter((agent) => this.#chosen(agent.id));
    const owners = await this.#readOwners(server.id, sourceServerId);
    for (const agent of chosen) {
      if (this.#stopped) return;
      try {
        await this.#syncAgent(server, sourceServerId, agent.id, owners);
      } catch (error) {
        logger.warn("Could not bring a copy up to date.", { agentId: agent.id, message: messageOf(error) });
      }
    }
  }

  /** The owner of each copy on the server. A copy the server no longer has is forgotten here. */
  async #readOwners(serverId: string, sourceServerId: string): Promise<Map<string, HandoverOwner>> {
    const rows = this.#store.listOutgoing(serverId).filter((row) => row.registered);
    const owners = new Map<string, HandoverOwner>();
    for (let start = 0; start < rows.length; start += TRAVEL_HANDOVER_AGENTS) {
      const agentIds = rows.slice(start, start + TRAVEL_HANDOVER_AGENTS).map((row) => row.localAgentId);
      const status = decodeStatus(
        await this.#remote.call(serverId, TRAVEL_HANDOVER_ROUTES.status, { sourceServerId, agentIds }),
      );
      for (const entry of status) owners.set(entry.sourceAgentId, entry.owner);
    }
    let changed = false;
    for (const row of rows) {
      const owner = owners.get(row.localAgentId);
      if (!owner) {
        this.#store.forgetOutgoing(serverId, row.localAgentId);
        changed ||= row.owner === "copy";
      } else if (owner !== row.owner) {
        this.#store.setOutgoingOwner(serverId, row.localAgentId, owner);
        changed = true;
      }
    }
    if (changed) this.#changed();
    return owners;
  }

  async #syncAgent(
    server: HandoverServerEntry,
    sourceServerId: string,
    agentId: string,
    owners: ReadonlyMap<string, HandoverOwner>,
  ): Promise<void> {
    let row = this.#store.outgoing(server.id, agentId);
    if (!row?.remoteAgentId) {
      const remoteAgentId = await this.#remote.copyAgent(server.id, agentId);
      row = this.#store.recordCopy(server.id, agentId, remoteAgentId, server.name);
      logger.info("Made a travel copy of an agent.", { agentId });
    }
    const source = { sourceServerId, sourceAgentId: agentId };
    if (!row.registered) {
      await this.#remote.call(server.id, TRAVEL_HANDOVER_ROUTES.register, { ...source, agentId: row.remoteAgentId });
      this.#store.markRegistered(server.id, agentId);
    } else if (owners.get(agentId) === "copy") return;
    await this.#push(server.id, source, row);
  }

  async #push(serverId: string, source: { sourceServerId: string; sourceAgentId: string }, row: OutgoingAgent) {
    const threadId = this.#conversation.agent(source.sourceAgentId)?.threadId;
    if (!threadId) return;
    let cursor = row.localThreadId === threadId ? row.cursor : 0;
    for (let push = 0; push < PUSHES_PER_ROUND; push += 1) {
      const changes = readChatChanges(this.#conversation.connection, threadId, cursor);
      if (changes.skipped > 0)
        logger.warn("Left unreadable messages out of a travel copy.", {
          agentId: source.sourceAgentId,
          count: changes.skipped,
        });
      try {
        if (changes.messages.length > 0)
          await this.#remote.call(serverId, TRAVEL_HANDOVER_ROUTES.push, { ...source, messages: changes.messages });
      } catch (error) {
        if (error instanceof RemoteRequestError && error.status === TRAVEL_HANDOVER_TAKEN_OVER) {
          this.#store.setOutgoingOwner(serverId, source.sourceAgentId, "copy");
          this.#changed();
          return;
        }
        if (error instanceof RemoteRequestError && error.status === TRAVEL_HANDOVER_NOT_REGISTERED) {
          this.#store.forgetOutgoing(serverId, source.sourceAgentId);
          return;
        }
        throw error;
      }
      // A cursor that does not move waits for a streaming message to finish.
      if (changes.lastSequence === cursor) return;
      cursor = changes.lastSequence;
      this.#store.advance(serverId, source.sourceAgentId, threadId, cursor);
      if (!changes.more) return;
    }
  }

  #chosen(agentId: string): boolean {
    const settings = this.#settings();
    return settings !== null && (settings.agents === null || settings.agents.includes(agentId));
  }

  /** The server that the file names, by id or by name. */
  #server(): HandoverServerEntry | null {
    const settings = this.#settings();
    if (!settings) return null;
    const remote = this.#remote.servers().filter((server) => server.kind === "remote");
    return (
      remote.find((server) => server.id === settings.server) ??
      remote.find((server) => server.name.toLowerCase() === settings.server.toLowerCase()) ??
      null
    );
  }

  #requireLocalServerId(): string {
    const id = this.#localServerId();
    if (!id) throw new Error(sourceText("error.agent.handoverUnavailable", { server: this.#settings()?.server ?? "" }));
    return id;
  }

  #schedule(delayMs?: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const minutes = this.#settings()?.everyMinutes ?? HANDOVER_DEFAULT_MINUTES;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        void this.round();
      },
      delayMs ?? minutes * 60_000,
    );
    this.#timer.unref?.();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeStatus(value: unknown): { sourceAgentId: string; owner: HandoverOwner }[] {
  if (!isDynamicRecord(value) || !Array.isArray(value.agents)) throw new Error("Invalid handover status.");
  return value.agents.flatMap((entry) =>
    isDynamicRecord(entry) &&
    typeof entry.sourceAgentId === "string" &&
    (entry.owner === "source" || entry.owner === "copy")
      ? [{ sourceAgentId: entry.sourceAgentId, owner: entry.owner }]
      : [],
  );
}

function decodePull(value: unknown): { messages: ConversationMessage[]; lastSequence: number; more: boolean } {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.messages) ||
    typeof value.lastSequence !== "number" ||
    typeof value.more !== "boolean"
  )
    throw new Error("Invalid handover messages.");
  return { messages: value.messages.filter(isConversationMessage), lastSequence: value.lastSequence, more: value.more };
}
