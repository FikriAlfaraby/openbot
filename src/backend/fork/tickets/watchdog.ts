// Fork module (super-agent, roadmap item 4.1). The Watchdog's scheduled wake, after the DeepSeek
// Super-agent article (section 6): a separate agent session, driven by scheduled messages, that
// judges whether work makes progress, not only whether a process lives.
//
// The host checks the tickets every few minutes. When the configured interval has passed and any
// ticket is live, it queues one message to the agent with the role `watchdog`, with the tickets that
// look stuck. With no live ticket nothing is sent, so a quiet team costs no tokens.

import type { Ticket, TicketState, TicketStore } from "./ticket-store";

export const DEFAULT_WATCHDOG = { everyMinutes: 30, staleMinutes: 60 } as const;

const LIVE: readonly TicketState[] = ["working", "awaiting_human", "review", "blocked"];

export type WatchdogFlag = "no_progress" | "blocked" | "waits_long" | "review_waits";

export interface WatchdogFinding {
  ticket: number;
  title: string;
  state: TicketState;
  assignee: string | null;
  t3ThreadId: string | null;
  minutesSinceUpdate: number;
  flag: WatchdogFlag;
}

/** The live tickets, and the ones that look stuck, by how long they did not change. */
export function watchdogFindings(
  store: TicketStore,
  staleMinutes: number,
  now: () => Date = () => new Date(),
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
  return { live: live.length, findings };
}

function flagOf(ticket: Ticket, minutes: number, staleMinutes: number): WatchdogFlag | null {
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
  ]
    .filter(Boolean)
    .join("\n");
}

/** Whether the interval has passed since the last wake. */
export function watchdogDue(lastWake: number | null, everyMinutes: number, now: number): boolean {
  return lastWake === null || now - lastWake >= everyMinutes * 60_000;
}
