// Fork module (docs/fork/travel-handover.md). The conversation steps of travel handover, on either
// side: write copied messages into an agent's own chat, tell whether the chat is busy, and end the
// chat's provider sessions so that the next turn starts from the stored history.
//
// Messages are written through the conversation's own transaction, as a system line is, so the
// cached snapshot stays right and every connected client (the phone) gets the new messages.

import type { DatabaseSync } from "node:sqlite";
import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import type { AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { ConversationRuntime } from "../../agent/conversation-runtime";
import type { ThreadLifecycle } from "../../agent/thread-lifecycle";
import type { OpenBotDatabase } from "../../openbot-database";

/** The event type of copied messages. Replay reads the payload, so it needs no case of its own. */
const HANDOVER_EVENT_TYPE = "fork.handover-copied";

export interface HandoverConversationOptions {
  conversation: ConversationRuntime;
  threads: ThreadLifecycle;
  database: OpenBotDatabase;
  listAgents: () => AgentSummary[];
}

/** What the two sides of travel handover use, so a test can give its own database. */
export type HandoverChat = Pick<
  HandoverConversation,
  "userDataPath" | "connection" | "agent" | "agents" | "writeMainChat" | "busy" | "endContext"
>;

/** Owns no state: each call reads the agent and its chat again. */
export class HandoverConversation {
  readonly #conversation: ConversationRuntime;
  readonly #threads: ThreadLifecycle;
  readonly #database: OpenBotDatabase;
  readonly #listAgents: () => AgentSummary[];

  constructor(options: HandoverConversationOptions) {
    this.#conversation = options.conversation;
    this.#threads = options.threads;
    this.#database = options.database;
    this.#listAgents = options.listAgents;
  }

  get userDataPath(): string {
    return this.#database.userDataPath;
  }

  /** Read at each use: the handle closes with the database. */
  get connection(): DatabaseSync {
    return this.#database.connection;
  }

  agent(agentId: string): AgentSummary | null {
    return this.#listAgents().find((candidate) => candidate.id === agentId) ?? null;
  }

  agents(): AgentSummary[] {
    return this.#listAgents();
  }

  /** Writes the messages into the agent's own chat, made when it has none, and returns the chat's id. */
  writeMainChat(agentId: string, messages: readonly ConversationMessage[]): string {
    const database = this.#database;
    return this.#conversation.withConversationTransaction(agentId, ({ threadId, snapshot }) => {
      if (messages.length === 0) return { result: threadId, snapshot };
      const written = new Set(messages.map((message) => message.id));
      snapshot.messages = [...snapshot.messages.filter((message) => !written.has(message.id)), ...messages];
      sortConversationMessages(snapshot.messages);
      snapshot.revision = database.persistConversationChanges({
        agentId,
        threadId,
        activeTurnId: snapshot.activeTurnId,
        changedMessages: messages,
        eventType: HANDOVER_EVENT_TYPE,
      });
      return { result: threadId, snapshot };
    });
  }

  /** Whether a turn, a start or a compaction holds the agent's own chat. */
  busy(agentId: string): boolean {
    const agent = this.agent(agentId);
    return agent !== null && this.#threads.mainContextBusy(agent);
  }

  /** Ends the provider sessions of the agent's own chat; its next turn gets the stored history. */
  async endContext(agentId: string): Promise<void> {
    const threadId = this.agent(agentId)?.threadId;
    if (threadId) await Effect.runPromise(this.#threads.endThreadContext(threadId));
  }
}
