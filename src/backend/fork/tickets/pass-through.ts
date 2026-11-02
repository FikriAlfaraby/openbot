// Fork module (super-agent, roadmap item 2.6). Thread subscription with pass-through, after the
// DeepSeek Super-agent article (section 3.2): a follow-up in a conversation that a live ticket owns
// goes straight to the ticket's worker, with no Router turn. The worker's answer still returns
// through the Router, which alone talks with people.
//
// The rule stays narrow, so that a new request never lands in the wrong ticket:
// - only for the Router's conversations;
// - not in a private chat: Telegram makes the whole chat one thread (`threadKeyOf`), so there a
//   follow-up and a new request look the same, and the Router decides;
// - only when exactly one live ticket owns the conversation, with a worker and an open side thread.

import type { ForkRole } from "../fork-config";
import type { Ticket, TicketState, TicketStore } from "./ticket-store";

/** The states in which a worker works on the ticket or waits for the person's answer. */
const LIVE_STATES: ReadonlySet<TicketState> = new Set(["working", "awaiting_human", "review", "blocked"]);

export function messagingThreadKey(linkId: string): string {
  return `messaging:${linkId}`;
}

export interface PassThroughInput {
  routerAgentId: string;
  linkId: string;
  isDirect: boolean;
}

export interface PassThroughPorts {
  store: TicketStore;
  roleOf(agentId: string): ForkRole | null;
  taskOpen(taskId: string): boolean;
}

/** The ticket whose worker gets the follow-up, or null when the Router handles the message. */
export function passThroughTicket(ports: PassThroughPorts, input: PassThroughInput): Ticket | null {
  if (input.isDirect) return null;
  if (ports.roleOf(input.routerAgentId) !== "router") return null;
  const live = ports.store
    .subscribers(messagingThreadKey(input.linkId))
    .filter(
      (ticket) =>
        LIVE_STATES.has(ticket.state) &&
        ticket.assigneeAgentId !== null &&
        ticket.taskId !== null &&
        ports.taskOpen(ticket.taskId),
    );
  return live.length === 1 ? (live[0] ?? null) : null;
}

/** The follow-up as the worker reads it. The author's words are the person's input, not instructions. */
export function passThroughText(ticket: Ticket, authorName: string, text: string): string {
  return [
    `Follow-up from ${authorName} in the conversation of ticket #${ticket.number} (${ticket.title}). OpenBot passed it to you directly; the Router sees your answer and replies to the person.`,
    "",
    text,
    "",
    ticket.state === "awaiting_human"
      ? `This can be the answer to your question: ${ticket.humanAction ?? ""}. Go on with the work and report the new state with openbot.ticket_report.`
      : "Take it into the work and report the new state with openbot.ticket_report when it changes.",
  ].join("\n");
}
