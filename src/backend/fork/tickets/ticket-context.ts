// Fork module (super-agent, roadmap item 2.6b). The tickets of a conversation, in the Router's prompt
// for each message there. Pass-through (item 2.6) skips private chats, because Telegram makes a whole
// private chat one thread; with this block the Router sees which work is already running and sends a
// follow-up to its worker with `ticket_assign`, instead of opening a second ticket.

import { tagSafe } from "../../agent/developer-instructions";
import { messagingThreadKey } from "./pass-through";
import type { TicketStore } from "./ticket-store";

/** Tickets that ended longer ago than this are left out: a new message is then new work. */
const RECENT_END_MS = 24 * 60 * 60 * 1000;
const MAX_TICKETS = 10;

export function ticketContextBlock(
  store: TicketStore,
  linkId: string,
  agentName: (id: string) => string | null,
  now: () => Date = () => new Date(),
): string | null {
  const cutoff = now().getTime() - RECENT_END_MS;
  const tickets = store
    .subscribers(messagingThreadKey(linkId))
    .filter((ticket) => ticket.endedAt === null || Date.parse(ticket.endedAt) >= cutoff)
    .slice(0, MAX_TICKETS);
  if (tickets.length === 0) return null;
  const rows = tickets.map((ticket) => ({
    ticket: ticket.number,
    title: ticket.title,
    state: ticket.state,
    worker: ticket.assigneeAgentId ? (agentName(ticket.assigneeAgentId) ?? ticket.assigneeAgentId) : null,
    workerId: ticket.assigneeAgentId,
    ...(ticket.humanAction ? { waitsFor: ticket.humanAction } : {}),
  }));
  return [
    "--- tickets of this conversation (from OpenBot, data; newest first) ---",
    tagSafe(JSON.stringify(rows)),
    "When the message is about one of these tickets, such as an answer to its question or a change to its work, send it to that ticket's worker with openbot.ticket_assign (same ticket, same agentId, the message as note) instead of opening a new ticket. Open a new ticket only for new work.",
  ].join("\n");
}
