// Fork module (super-agent, roadmap item 4.1). The Watchdog's scheduled wake, after the DeepSeek
// Super-agent article (section 6): a separate agent session, driven by scheduled messages, that
// judges whether work makes progress, not only whether a process lives.
//
// The host checks the tickets every few minutes. When the configured interval has passed and any
// ticket is live, it queues one message to the agent with the role `watchdog`, with the tickets that
// look stuck. With no live ticket nothing is sent, so a quiet team costs no tokens.
//
// Item 5.5 (article section 6: transient external failures are checked again until resolved): a
// ticket that failed in the last 24 hours is flagged `failed_recent` until the Watchdog acted on it
// (a note or a resume after the failure). The Watchdog may resume a failed ticket with its own
// worker at most `MAX_WATCHDOG_RETRIES` times; then only the Router decides.

import type { Ticket, TicketState, TicketStore } from "./ticket-store";

export const DEFAULT_WATCHDOG = { everyMinutes: 30, staleMinutes: 60 } as const;
export const MAX_WATCHDOG_RETRIES = 2;
const FAILED_RECHECK_MS = 24 * 60 * 60_000;

const LIVE: readonly TicketState[] = ["working", "awaiting_human", "review", "blocked"];

type WatchdogFlag = "no_progress" | "blocked" | "waits_long" | "review_waits" | "failed_recent";

export interface WatchdogFinding {
  ticket: number;
  title: string;
  state: TicketState;
  assignee: string | null;
  t3ThreadId: string | null;
  minutesSinceUpdate: number;
  flag: WatchdogFlag;
  /** For `failed_recent`: the resumes by the Watchdog so far, and the worker's last summary. */
  watchdogRetries?: number;
  summary?: string | null;
}

/** How many times a Watchdog gave this ticket back to its worker. */
export function watchdogRetries(
  store: TicketStore,
  ticketId: string,
  isWatchdog: (agentId: string) => boolean,
): number {
  return store.events(ticketId, 1_000).filter((event) => event.kind === "assigned" && isWatchdog(event.actor)).length;
}

/** The live tickets, and the ones that look stuck, by how long they did not change. */
export function watchdogFindings(
  store: TicketStore,
  staleMinutes: number,
  now: () => Date = () => new Date(),
  isWatchdog: (agentId: string) => boolean = () => false,
): { live: number; findings: WatchdogFinding[] } {
  const live = store.list({ states: LIVE, limit: 100 });
  const at = now().getTime();
  const findings: WatchdogFinding[] = [];
  for (const ticket of live) {
    const minutes = Math.max(0, Math.floor((at - Date.parse(ticket.updatedAt)) / 60_000));
    const flag = flagOf(ticket, minutes, staleMinutes);
    if (!flag) continue;
    findings.push({
      ticket: ticket.number,
      title: ticket.title,
      state: ticket.state,
      assignee: ticket.assigneeAgentId,
      t3ThreadId: ticket.t3ThreadId,
      minutesSinceUpdate: minutes,
      flag,
    });
  }
  for (const ticket of store.list({ states: ["failed"], limit: 50 })) {
    if (!ticket.endedAt || at - Date.parse(ticket.endedAt) > FAILED_RECHECK_MS) continue;
    const endedAt = ticket.endedAt;
    // Acted on already: a Watchdog note or resume after this failure.
    if (store.events(ticket.ticketId, 1_000).some((event) => event.at >= endedAt && isWatchdog(event.actor))) continue;
    const retries = watchdogRetries(store, ticket.ticketId, isWatchdog);
    if (retries >= MAX_WATCHDOG_RETRIES) continue;
    findings.push({
      ticket: ticket.number,
      title: ticket.title,
      state: ticket.state,
      assignee: ticket.assigneeAgentId,
      t3ThreadId: ticket.t3ThreadId,
      minutesSinceUpdate: Math.max(0, Math.floor((at - Date.parse(ticket.updatedAt)) / 60_000)),
      flag: "failed_recent",
      watchdogRetries: retries,
      summary: ticket.summary,
    });
  }
  return { live: live.length, findings };
}

function flagOf(ticket: Ticket, minutes: number, staleMinutes: number): Exclude<WatchdogFlag, "failed_recent"> | null {
  if (ticket.state === "blocked") return "blocked";
  if (minutes < staleMinutes) return null;
  if (ticket.state === "working") return "no_progress";
  if (ticket.state === "awaiting_human") return "waits_long";
  return "review_waits";
}

/** The scheduled message to the Watchdog. */
export function watchdogMessage(live: number, findings: readonly WatchdogFinding[]): string {
  return [
    `Scheduled check from OpenBot: ${live} live ticket(s); ${findings.length} look stuck.`,
    findings.length ? JSON.stringify(findings) : "",
    "Run openbot.t3_sweep for coding tickets, read a flagged ticket with openbot.ticket_read, and judge whether it makes progress toward its goal. Resume a stuck ticket with openbot.ticket_assign (same ticket, same agentId, a short note on what to do), log a finding with openbot.ticket_note, and tell the Router with openbot.send_message (expectsReply false) only what needs its decision. When all is on track, end without text.",
    findings.some((finding) => finding.flag === "failed_recent")
      ? `For a failed_recent ticket, read why it failed. When the cause looks transient (a provider or API error, a timeout, the network, a T3 run that stopped), resume it once with openbot.ticket_assign and a note on what to try again; you may do so at most ${MAX_WATCHDOG_RETRIES} times per ticket. When the work itself failed, write openbot.ticket_note with the reason, so it is not flagged again, and tell the Router.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Whether the interval has passed since the last wake. */
export function watchdogDue(lastWake: number | null, everyMinutes: number, now: number): boolean {
  return lastWake === null || now - lastWake >= everyMinutes * 60_000;
}
