// Fork module (super-agent, roadmap item 3.2; the idea of the charliedowler fork). When the side
// thread of a ticket's worker ends a turn as failed or interrupted while the ticket is working, the
// ticket moves to `blocked` and the Router gets one note, so the work does not stay stopped until a
// person opens the desktop app. The Router resumes it with `ticket_assign` or ends it with
// `ticket_close`. A turn that completes needs nothing here: its answer already returns to the Router.

import type { Ticket, TicketStore } from "./ticket-store";

export type TaskTurnStatus = "completed" | "failed" | "interrupted";

export interface StoppedTicket {
  ticket: Ticket;
  /** The note for the Router. */
  text: string;
  /** One note for each stop: a repeated end event of the same turn adds nothing. */
  idempotencyKey: string;
  /** The delivery whose conversation the ticket came from, to answer there, or null. */
  originDeliveryId: string | null;
}

/** The delivery id in a ticket's source key `delivery:<id>:<title>`, as `ticket_create` writes it. */
export function originDeliveryId(sourceKey: string | null): string | null {
  const match = sourceKey ? /^delivery:([^:]+):/u.exec(sourceKey) : null;
  return match?.[1] ?? null;
}

/**
 * Records a stopped worker turn on its ticket. Returns what the Router must hear, or null when the
 * turn completed, the task has no ticket, or the ticket is not working.
 */
export function recordStoppedTurn(
  store: TicketStore,
  taskId: string,
  status: TaskTurnStatus,
  turnId: string | null,
): StoppedTicket | null {
  if (status === "completed") return null;
  const ticket = store.byTask(taskId);
  if (ticket?.state !== "working" || !ticket.assigneeAgentId) return null;
  const why = status === "failed" ? "the worker's turn failed" : "the worker's turn was interrupted";
  const blocked = store.transition(ticket.ticketId, "blocked", {
    actor: "host",
    note: why,
    summary: ticket.summary ?? `Stopped: ${why}.`,
  });
  return {
    ticket: blocked,
    idempotencyKey: `ticket-stop:${ticket.ticketId}:${turnId ?? blocked.updatedAt}`,
    originDeliveryId: originDeliveryId(ticket.sourceKey),
    text: [
      `Ticket #${blocked.number} (${blocked.title}) stopped: ${why}. It is now blocked.`,
      blocked.summary ? `Last summary: ${blocked.summary}` : null,
      `Decide now: resume it with openbot.ticket_assign (ticket ${blocked.number}, agentId ${blocked.assigneeAgentId}, a note on what to do), or end it with openbot.ticket_close and the reason. Tell the person in one short line only when the work cannot go on.`,
    ]
      .filter((line) => line !== null)
      .join("\n"),
  };
}
