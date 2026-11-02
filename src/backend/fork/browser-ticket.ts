// Fork module (super-agent, roadmap item 4.3). A browser session per ticket.
//
// A tab that an agent opens from the side thread of a live ticket opens in a session of that ticket,
// not in the agent's own session or the shared one. Two tickets of the same worker then share no
// cookies, sign-ins or storage, and one ticket's pages cannot see another's. When the ticket ends
// (done, failed, cancelled), the host closes its tabs and deletes the session's data.
//
// A named browser profile that the owner chose for the agent comes first: the owner signed in there
// on purpose, so its tabs stay in it.
//
// The session is an agent-kind session whose key is a hash of the ticket id, so saved tabs and the
// browser state file need no new field: its folder is `Partitions/openbot-browser-agent-<hash>`.

import type { AgentBrowserProfile } from "@openbot/contracts/ipc";
import { Effect, Result } from "effect";
import { agentBrowserSessionKey } from "../browser-state";
import { ENDED_TICKET_STATES, type TicketStore } from "./tickets/ticket-store";

/** The session of one ticket's tabs. */
export function ticketBrowserSession(ticketId: string): { kind: "agent"; key: string } {
  return { kind: "agent", key: agentBrowserSessionKey(`fork-ticket:${ticketId}`) };
}

/** Whether a new tab of this thread opens in its ticket's session. */
export function usesTicketSession(profile: AgentBrowserProfile, ticketId: string | null): ticketId is string {
  return ticketId !== null && profile.kind !== "profile";
}

/** The live ticket whose worker runs in this task, or null. */
export function liveTicketOfTask(store: TicketStore, taskId: string | null): string | null {
  if (!taskId) return null;
  const ticket = store.byTask(taskId);
  return ticket && !ENDED_TICKET_STATES.has(ticket.state) ? ticket.ticketId : null;
}

/**
 * Clears the sessions of the tickets that ended and were not cleared in this process yet. A session
 * that never opened costs nothing to clear. Returns the tickets cleared.
 */
export const sweepTicketBrowserSessions = Effect.fn("ForkBrowser.sweep")(function* (
  store: TicketStore,
  clear: (ticketId: string) => Effect.Effect<void, unknown>,
  cleared: Set<string>,
) {
  const ended = store.list({ states: [...ENDED_TICKET_STATES], limit: 50 });
  const done: string[] = [];
  for (const ticket of ended) {
    if (cleared.has(ticket.ticketId)) continue;
    const result = yield* Effect.result(clear(ticket.ticketId));
    // A session in use or a failed delete is tried again at the next sweep.
    if (Result.isSuccess(result)) {
      cleared.add(ticket.ticketId);
      done.push(ticket.ticketId);
    }
  }
  return done;
});
