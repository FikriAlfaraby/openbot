// Fork module (docs/fork/travel-handover.md). The one check before a person's message reaches an
// agent's own chat. On the server, a message in a copy makes the server the chat's owner. On the
// computer, a message in a chat that a server owns is refused, so the chat never splits in two.
// Copied messages do not pass here: they are written, never sent.

import type { DatabaseSync } from "node:sqlite";
import { sourceText } from "@openbot/i18n/source";
import { lastChatSequence } from "./handover-messages";
import type { HandoverStore } from "./handover-store";

export function handoverBeforeUserMessage(
  store: HandoverStore,
  db: DatabaseSync,
  agent: { id: string; threadId: string | null },
  taskId: string | null,
): void {
  // Only the agent's own chat is copied; a task runs beside it.
  if (taskId) return;
  const locked = store.lockedOutgoing(agent.id);
  if (locked)
    throw new Error(sourceText("error.agent.handoverLocked", { server: locked.serverName || locked.serverId }));
  const incoming = store.incomingByAgent(agent.id);
  if (!incoming || incoming.owner === "copy") return;
  const threadId = incoming.threadId ?? agent.threadId;
  store.takeOver(agent.id, threadId ? lastChatSequence(db, threadId) : 0);
}
