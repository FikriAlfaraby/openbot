// Fork module (super-agent, roadmap item 5.2). Chat commands that the host answers itself, on the
// article's fast path (DeepSeek Super-agent, section 3: code decides what needs no model). A person
// in the Router's Telegram, Slack or Discord conversation writes `/tiket` (or `/tickets`, `/status`)
// and gets the tickets of that conversation at once: no Router turn, no tokens, no wait behind a
// running turn. In a Telegram group the command can carry the bot's name: `/tiket@NamaBot`.
//
// Only the agent with the role `router` has the command; in every other conversation the message
// goes to the agent as before. The reply is in Indonesian or English (`chat.commandLanguage`).

import { messagingThreadKey } from "./tickets/pass-through";
import type { Ticket, TicketState, TicketStore } from "./tickets/ticket-store";

export type ChatCommand = "tickets";
export type CommandLanguage = "id" | "en";

const COMMAND = /^\/(tiket|tickets|status)(@[A-Za-z0-9_]{1,64})?\s*$/iu;
const RECENT_END_MS = 24 * 60 * 60_000;
const MAX_LINES = 15;

export function chatCommandOf(text: string): ChatCommand | null {
  return COMMAND.test(text.trim()) ? "tickets" : null;
}

const WORDS: Record<CommandLanguage, { title: string; none: string; states: Record<TicketState, string> }> = {
  id: {
    title: "Tiket di percakapan ini:",
    none: "Belum ada tiket di percakapan ini.",
    states: {
      open: "baru",
      working: "dikerjakan",
      awaiting_human: "menunggu jawaban",
      review: "siap dicek",
      blocked: "terhambat",
      done: "selesai",
      failed: "gagal",
      cancelled: "dibatalkan",
    },
  },
  en: {
    title: "Tickets of this conversation:",
    none: "No tickets in this conversation yet.",
    states: {
      open: "new",
      working: "in progress",
      awaiting_human: "waits for an answer",
      review: "ready to check",
      blocked: "blocked",
      done: "done",
      failed: "failed",
      cancelled: "cancelled",
    },
  },
};

function line(
  ticket: Ticket,
  words: (typeof WORDS)[CommandLanguage],
  agentName: (id: string) => string | null,
): string {
  const worker = ticket.assigneeAgentId ? (agentName(ticket.assigneeAgentId) ?? ticket.assigneeAgentId) : null;
  const question =
    ticket.state === "awaiting_human" && ticket.humanAction
      ? `: ${ticket.humanAction.replace(/\s+/gu, " ").slice(0, 120)}`
      : "";
  return `#${ticket.number} ${ticket.title} — ${words.states[ticket.state]}${worker ? ` (${worker})` : ""}${question}`;
}

/**
 * The reply to `/tiket` in one conversation: its live tickets first, then the ones that ended in the
 * last 24 hours, newest first in each group.
 */
export function ticketStatusReply(
  store: TicketStore,
  linkId: string,
  agentName: (id: string) => string | null,
  language: CommandLanguage = "id",
  now: () => Date = () => new Date(),
): string {
  const words = WORDS[language];
  const cutoff = now().getTime() - RECENT_END_MS;
  const tickets = store.subscribers(messagingThreadKey(linkId));
  const live = tickets.filter((ticket) => ticket.endedAt === null);
  const ended = tickets.filter((ticket) => ticket.endedAt !== null && Date.parse(ticket.endedAt) >= cutoff);
  const shown = [...live, ...ended].slice(0, MAX_LINES);
  if (shown.length === 0) return words.none;
  return [words.title, ...shown.map((ticket) => line(ticket, words, agentName))].join("\n");
}
