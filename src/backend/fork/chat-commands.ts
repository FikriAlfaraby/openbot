// Fork module (super-agent, roadmap item 5.2). Chat commands that the host answers itself, on the
// article's fast path (DeepSeek Super-agent, section 3: code decides what needs no model). A person
// in the Router's Telegram, Slack or Discord conversation writes `/tiket` (or `/tickets`, `/status`)
// and gets the tickets of that conversation at once: no Router turn, no tokens, no wait behind a
// running turn. In a Telegram group the command can carry the bot's name: `/tiket@NamaBot`.
//
// Only the agent with the role `router` has the command; in every other conversation the message
// goes to the agent as before. The reply is in Indonesian or English (`chat.commandLanguage`).
//
// Item 5.7: `/tiket 12` (or `/tiket #12`) shows one ticket of the conversation: state, worker, the
// open question, the worker's last summary and the last steps. A ticket of another conversation is
// not shown, so one chat cannot read another's work.
//
// Item 5.8: `/bantuan` (or `/help`) lists what a person can do in the chat. The OpenBot Telegram bot
// belongs to the account service, so the host cannot set the bot's command menu; this is the menu.
//
// Item 5.9: `/selesai 12` (or `/done 12`) is the sign-off of the article (section 4.2: a person is
// asked only for decisions and sign-offs). The person who asked for the work closes a ticket that
// waits in `review` as `done`, with no Router turn. Only that person: the platform and user id in
// the ticket's mandate must match the sender.

import { parseMandate } from "./tickets/mandate";
import { messagingThreadKey } from "./tickets/pass-through";
import type { Ticket, TicketState, TicketStore } from "./tickets/ticket-store";

export type ChatCommand =
  | { kind: "tickets" }
  | { kind: "ticket"; number: number }
  | { kind: "help" }
  | { kind: "done"; number: number };
export type CommandLanguage = "id" | "en";

const COMMAND = /^\/(tiket|tickets|status)(@[A-Za-z0-9_]{1,64})?(?:\s+#?(\d{1,7}))?\s*$/iu;
const RECENT_END_MS = 24 * 60 * 60_000;
const MAX_LINES = 15;

const HELP_COMMAND = /^\/(bantuan|help)(@[A-Za-z0-9_]{1,64})?\s*$/iu;
const DONE_COMMAND = /^\/(selesai|done)(@[A-Za-z0-9_]{1,64})?\s+#?(\d{1,7})\s*$/iu;

export function chatCommandOf(text: string): ChatCommand | null {
  if (HELP_COMMAND.test(text.trim())) return { kind: "help" };
  const done = DONE_COMMAND.exec(text.trim());
  if (done) return { kind: "done", number: Number(done[3]) };
  const match = COMMAND.exec(text.trim());
  if (!match) return null;
  return match[3] ? { kind: "ticket", number: Number(match[3]) } : { kind: "tickets" };
}

interface Words {
  title: string;
  none: string;
  notHere: (number: number) => string;
  question: string;
  summary: string;
  steps: string;
  created: string;
  assigned: string;
  states: Record<TicketState, string>;
}

const WORDS: Record<CommandLanguage, Words> = {
  id: {
    title: "Tiket di percakapan ini:",
    none: "Belum ada tiket di percakapan ini.",
    notHere: (number) => `Tiket #${number} tidak ada di percakapan ini.`,
    question: "Menunggu jawaban",
    summary: "Ringkasan",
    steps: "Langkah terakhir",
    created: "dibuat",
    assigned: "diberikan ke",
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
    notHere: (number) => `Ticket #${number} is not in this conversation.`,
    question: "Waits for an answer",
    summary: "Summary",
    steps: "Last steps",
    created: "created",
    assigned: "given to",
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

function line(ticket: Ticket, words: Words, agentName: (id: string) => string | null): string {
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

const MAX_STEPS = 5;
const SUMMARY_CHARACTERS = 600;

/** `2026-11-02 12:05 UTC`, the same for every reader. */
function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The reply to `/tiket <number>`: one ticket of this conversation (item 5.7). */
export function ticketDetailReply(
  store: TicketStore,
  linkId: string,
  number: number,
  agentName: (id: string) => string | null,
  language: CommandLanguage = "id",
): string {
  const words = WORDS[language];
  const ticket = store.subscribers(messagingThreadKey(linkId)).find((candidate) => candidate.number === number);
  if (!ticket) return words.notHere(number);
  const name = (id: string) => agentName(id) ?? id;
  // State changes and hand-overs only: notes are the Router's and the Watchdog's working log.
  const steps = store
    .events(ticket.ticketId, 200)
    .flatMap((event) => {
      if (event.kind === "created") return [`${stamp(event.at)} ${words.created}`];
      if (event.kind === "assigned") return [`${stamp(event.at)} ${words.assigned} ${name(event.note ?? event.actor)}`];
      if (event.kind === "state" && event.toState) return [`${stamp(event.at)} ${words.states[event.toState]}`];
      return [];
    })
    .slice(-MAX_STEPS);
  const summary = ticket.summary?.replace(/\s+/gu, " ").trim();
  return [
    line({ ...ticket, humanAction: null }, words, agentName),
    ticket.state === "awaiting_human" && ticket.humanAction ? `${words.question}: ${ticket.humanAction}` : null,
    summary
      ? `${words.summary}: ${summary.length > SUMMARY_CHARACTERS ? `${summary.slice(0, SUMMARY_CHARACTERS - 1)}…` : summary}`
      : null,
    steps.length ? `${words.steps}:\n${steps.map((step) => `- ${step}`).join("\n")}` : null,
  ]
    .filter((part) => part !== null)
    .join("\n");
}

const HELP: Record<CommandLanguage, string> = {
  id: [
    "Cara memakai bot ini:",
    "- Tulis saja permintaanmu seperti ke rekan kerja. Untuk pekerjaan besar, bot membuat tiket dan memberi kabar di sini.",
    "- Balas pesan bot untuk menjawab pertanyaannya atau mengubah pekerjaan yang sedang jalan.",
    "- /tiket: daftar tiket di percakapan ini.",
    "- /tiket 12: detail tiket #12 (status, pertanyaan, ringkasan).",
    "- /selesai 12: setujui hasil tiket #12 yang siap dicek dan tutup tiketnya (hanya peminta).",
    "- stop: hentikan jawaban yang sedang ditulis bot.",
    "- /bantuan: pesan ini.",
  ].join("\n"),
  en: [
    "How to use this bot:",
    "- Write your request as to a colleague. For larger work the bot opens a ticket and reports here.",
    "- Reply to the bot's message to answer its question or change work in progress.",
    "- /tiket: the tickets of this conversation.",
    "- /tiket 12: ticket #12 in detail (state, question, summary).",
    "- /done 12: sign off ticket #12 when it is ready to check, and close it (the requester only).",
    "- stop: stop the answer the bot is writing.",
    "- /help: this message.",
  ].join("\n"),
};

/** The reply to `/bantuan` (item 5.8). */
export function helpReply(language: CommandLanguage = "id"): string {
  return HELP[language];
}

const DONE_WORDS: Record<
  CommandLanguage,
  { closed: (n: number) => string; notReview: (n: number, state: string) => string; notRequester: string }
> = {
  id: {
    closed: (n) => `Tiket #${n} ditutup sebagai selesai. Terima kasih!`,
    notReview: (n, state) => `Tiket #${n} belum siap dicek (status: ${state}), jadi belum bisa ditutup.`,
    notRequester: "Hanya orang yang meminta pekerjaan ini yang bisa menutup tiketnya. Minta bantuan Router bila perlu.",
  },
  en: {
    closed: (n) => `Ticket #${n} is closed as done. Thank you!`,
    notReview: (n, state) => `Ticket #${n} is not ready to check (state: ${state}), so it cannot be closed yet.`,
    notRequester: "Only the person who asked for this work can close its ticket. Ask the Router if needed.",
  },
};

/**
 * The reply to `/selesai <number>` (item 5.9): closes a ticket of this conversation that waits in
 * `review`, when the sender is the person in its mandate.
 */
export function signOffReply(
  store: TicketStore,
  linkId: string,
  number: number,
  sender: { platform: string; authorId: string },
  language: CommandLanguage = "id",
): string {
  const words = WORDS[language];
  const done = DONE_WORDS[language];
  const ticket = store.subscribers(messagingThreadKey(linkId)).find((candidate) => candidate.number === number);
  if (!ticket) return words.notHere(number);
  const requester = parseMandate(ticket.mandateJson)?.sender;
  if (!requester || requester.platform !== sender.platform || requester.authorId !== sender.authorId)
    return done.notRequester;
  if (ticket.state !== "review") return done.notReview(number, words.states[ticket.state]);
  store.transition(ticket.ticketId, "done", {
    actor: `person:${sender.platform}:${sender.authorId}`,
    note: "Signed off by the requester in chat.",
  });
  return done.closed(number);
}
