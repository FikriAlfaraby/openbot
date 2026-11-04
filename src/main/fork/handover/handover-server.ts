// Fork module (docs/fork/travel-handover.md). The server's side of travel handover: it keeps copies
// of a computer's agents, writes their chat messages, and owns each copy's chat once a person wrote
// in it. The Team API route `route-fork-handover.ts` calls it; it never imports the route.

import type { ConversationMessage } from "@openbot/contracts/ipc";
import {
  TRAVEL_HANDOVER_BUSY,
  TRAVEL_HANDOVER_NOT_REGISTERED,
  TRAVEL_HANDOVER_TAKEN_OVER,
} from "@openbot/contracts/team-protocol/fork-travel-handover-v1";
import type { HandoverChat } from "../../../backend/fork/handover/handover-conversation";
import { type ChatChanges, readChatChanges } from "../../../backend/fork/handover/handover-messages";
import {
  type HandoverOwner,
  type HandoverStore,
  handoverStoreFor,
  type IncomingAgent,
} from "../../../backend/fork/handover/handover-store";
import { HttpError } from "../../team-api/http-error";

/** The routine steps of the agent service that a copy needs. */
export interface HandoverRoutines {
  listRoutines(agentId: string): readonly { id: string; active: boolean }[];
  updateRoutine(input: { agentId: string; routineId: string; active: boolean }): unknown;
}

export interface HandoverSource {
  sourceServerId: string;
  sourceAgentId: string;
}

export interface HandoverServerOptions {
  conversation: HandoverChat;
  routines: HandoverRoutines;
  store?: HandoverStore;
}

export interface HandoverAgentStatus {
  sourceAgentId: string;
  agentId: string;
  owner: HandoverOwner;
  busy: boolean;
}

export class HandoverServer {
  readonly #conversation: HandoverChat;
  readonly #routines: HandoverRoutines;
  readonly #store: HandoverStore;

  constructor(options: HandoverServerOptions) {
    this.#conversation = options.conversation;
    this.#routines = options.routines;
    this.#store = options.store ?? handoverStoreFor(options.conversation.userDataPath);
  }

  /**
   * Makes `agentId` the copy of the computer's agent. The copy's routines stop: the computer's agent
   * runs them already, and a copy that ran them too would do each job twice.
   */
  register(input: HandoverSource & { agentId: string }): { owner: HandoverOwner } {
    if (!this.#conversation.agent(input.agentId))
      throw new HttpError(TRAVEL_HANDOVER_NOT_REGISTERED, `There is no agent ${input.agentId} on this server.`);
    let incoming: IncomingAgent;
    try {
      incoming = this.#store.registerIncoming(input.sourceServerId, input.sourceAgentId, input.agentId);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "The copy cannot be recorded.");
    }
    for (const routine of this.#routines.listRoutines(input.agentId))
      if (routine.active)
        this.#routines.updateRoutine({ agentId: input.agentId, routineId: routine.id, active: false });
    return { owner: incoming.owner };
  }

  /** Writes the messages into the copy's chat, unless a person took the chat over. */
  push(input: HandoverSource & { messages: readonly ConversationMessage[] }): {
    owner: HandoverOwner;
    threadId: string | null;
  } {
    const incoming = this.#require(input);
    if (incoming.owner === "copy")
      throw new HttpError(TRAVEL_HANDOVER_TAKEN_OVER, "A person continued this chat on the server.");
    if (input.messages.length === 0) return { owner: incoming.owner, threadId: incoming.threadId };
    const threadId = this.#conversation.writeMainChat(incoming.agentId, input.messages);
    if (incoming.threadId !== threadId) this.#store.setIncomingThread(incoming.agentId, threadId);
    return { owner: incoming.owner, threadId };
  }

  /** The owner of each copy that the server keeps. A copy whose agent is gone is left out. */
  status(input: { sourceServerId: string; agentIds: readonly string[] }): { agents: HandoverAgentStatus[] } {
    const agents: HandoverAgentStatus[] = [];
    for (const sourceAgentId of input.agentIds) {
      const incoming = this.#store.incomingBySource(input.sourceServerId, sourceAgentId);
      if (!incoming || !this.#conversation.agent(incoming.agentId)) continue;
      agents.push({
        sourceAgentId,
        agentId: incoming.agentId,
        owner: incoming.owner,
        busy: this.#conversation.busy(incoming.agentId),
      });
    }
    return { agents };
  }

  /** The messages written in the copy after a person took it over, from `after` on. */
  pull(input: HandoverSource & { after: number }): ChatChanges {
    const incoming = this.#require(input);
    const empty = { messages: [], lastSequence: input.after, more: false, skipped: 0 };
    if (incoming.owner === "source" || incoming.takeoverSequence === null) return empty;
    const threadId = incoming.threadId ?? this.#conversation.agent(incoming.agentId)?.threadId ?? null;
    if (!threadId) return empty;
    return readChatChanges(this.#conversation.connection, threadId, Math.max(input.after, incoming.takeoverSequence));
  }

  /**
   * The computer took the chat back. The copy's provider sessions end, so its next turn reads the
   * stored chat with what the computer adds by then.
   */
  async release(input: HandoverSource): Promise<{ owner: HandoverOwner }> {
    const incoming = this.#require(input);
    if (incoming.owner === "source") return { owner: "source" };
    if (this.#conversation.busy(incoming.agentId))
      throw new HttpError(TRAVEL_HANDOVER_BUSY, "The copy is still answering in this chat.");
    await this.#conversation.endContext(incoming.agentId);
    this.#store.release(incoming.agentId);
    return { owner: "source" };
  }

  #require(input: HandoverSource): IncomingAgent {
    const incoming = this.#store.incomingBySource(input.sourceServerId, input.sourceAgentId);
    if (!incoming || !this.#conversation.agent(incoming.agentId))
      throw new HttpError(TRAVEL_HANDOVER_NOT_REGISTERED, "This server keeps no copy of that agent.");
    return incoming;
  }
}

let current: HandoverServer | null = null;

/** The host's handover server, set once the agent service runs. */
export function forkHandoverServer(): HandoverServer | null {
  return current;
}

export function setForkHandoverServer(server: HandoverServer | null): void {
  current = server;
}
