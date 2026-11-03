// Fork module (super-agent, roadmap item 2.5). The ticket tools: the Router creates, assigns, lists
// and closes tickets; the assigned worker reports state. The host checks who may call what:
//
// - `ticket_create`, `ticket_assign`, `ticket_close`: the agent with the role `router` only.
// - `ticket_report`: the ticket's assignee only.
// - `ticket_list`, `ticket_read`: the Router, the Watchdog, and the assignee (its own tickets).
//
// The tool router gives the handler its ports, so this module needs no service of its own and the
// rules are testable without a running agent.

import { Effect } from "effect";
import { z } from "zod";
import type { ForkRole } from "../fork-config";
import type { PlatformGate } from "../gate";
import { buildMandate, mandateHolds } from "./mandate";
import {
  TICKET_LIMITS,
  TICKET_STATES,
  type Ticket,
  TicketError,
  type TicketSource,
  type TicketStore,
} from "./ticket-store";
import { MAX_WATCHDOG_RETRIES, watchdogRetries } from "./watchdog";

const TICKET_TOOL_NAMES = [
  "ticket_create",
  "ticket_assign",
  "ticket_list",
  "ticket_read",
  "ticket_report",
  "ticket_close",
  "ticket_note",
] as const;
export type TicketToolName = (typeof TICKET_TOOL_NAMES)[number];

export function isTicketTool(name: string): name is TicketToolName {
  return TICKET_TOOL_NAMES.some((tool) => tool === name);
}

/** A ticket by its number (12) or id (tkt_…). */
const TicketRef = z
  .union([z.number().int().min(1), z.string().min(1).max(64)])
  .describe("The ticket number, such as 12, or its id.");

const REPORT_STATES = ["working", "awaiting_human", "review", "blocked", "done", "failed"] as const;
const CLOSE_STATES = ["done", "failed", "cancelled"] as const;

const createShape = {
  title: z.string().min(1).max(TICKET_LIMITS.title).describe("One line that names the work."),
  brief: z
    .string()
    .min(1)
    .max(TICKET_LIMITS.brief)
    .describe(
      "Everything the worker needs and cannot see: the goal, the person's request in full, context, preferences, approved risky actions, and what done looks like.",
    ),
  assignTo: z.string().min(1).max(128).optional().describe("The agent id of the worker; omit to assign later."),
  scope: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("What the work may cover, in one sentence; the title when omitted. A wider scope needs a new ticket."),
};
const assignShape = {
  ticket: TicketRef,
  agentId: z.string().min(1).max(128).describe("The agent id of the worker."),
  note: z.string().max(TICKET_LIMITS.note).optional().describe("Extra context for this assignment or follow-up."),
};
const listShape = {
  states: z.array(z.enum(TICKET_STATES)).max(TICKET_STATES.length).optional(),
  limit: z.number().int().min(1).max(TICKET_LIMITS.list).optional(),
};
const readShape = { ticket: TicketRef };
const reportShape = {
  ticket: TicketRef,
  state: z.enum(REPORT_STATES),
  summary: z.string().min(1).max(TICKET_LIMITS.summary).describe("The result or the progress, with evidence."),
  humanAction: z
    .string()
    .max(TICKET_LIMITS.humanAction)
    .optional()
    .describe("Required for awaiting_human: the one decision a person must make, with the options."),
};
const noteShape = {
  ticket: TicketRef,
  note: z.string().min(1).max(TICKET_LIMITS.note).describe("One finding, such as why the work looks stuck."),
};
const closeShape = {
  ticket: TicketRef,
  state: z.enum(CLOSE_STATES),
  note: z.string().min(1).max(TICKET_LIMITS.note).describe("Why the ticket ends, in one sentence."),
};

export const TICKET_TOOL_DEFINITIONS = [
  {
    name: "ticket_create",
    description:
      "Router only. Open a ticket for one piece of work from a person, and optionally assign it at once. A retry of the same request returns the same ticket. Follow-ups in the same conversation reach the ticket.",
    shape: createShape,
  },
  {
    name: "ticket_assign",
    description:
      "Router only. Give a ticket to a worker. The worker runs it in a side thread of its own and its answer comes back to you. Also sends a follow-up to the worker of a ticket that is already assigned.",
    shape: assignShape,
  },
  {
    name: "ticket_list",
    description: "List tickets, newest first, with state, assignee and the last summary.",
    shape: listShape,
  },
  {
    name: "ticket_read",
    description: "Read one ticket with its recent events.",
    shape: readShape,
  },
  {
    name: "ticket_report",
    description:
      "Assignee only. Report the state of your ticket: working, review, done, blocked, failed, or awaiting_human with the decision a person must make. Report once when the state changes, not for each step.",
    shape: reportShape,
  },
  {
    name: "ticket_note",
    description: "Router or Watchdog. Add one finding to a ticket's log, such as why its work looks stuck.",
    shape: noteShape,
  },
  {
    name: "ticket_close",
    description: "Router only. End a ticket as done, failed or cancelled, with the reason.",
    shape: closeShape,
  },
] as const;

const schemas = {
  ticket_create: z.strictObject(createShape),
  ticket_assign: z.strictObject(assignShape),
  ticket_list: z.strictObject(listShape),
  ticket_read: z.strictObject(readShape),
  ticket_report: z.strictObject(reportShape),
  ticket_close: z.strictObject(closeShape),
  ticket_note: z.strictObject(noteShape),
} satisfies Record<TicketToolName, z.ZodType>;

export interface TicketWorkerTaskInput {
  workerAgentId: string;
  routerAgentId: string;
  /** The side thread to reuse for a follow-up, or null for a new one. */
  taskId: string | null;
  title: string;
  text: string;
}

/** What the tool router gives the handler. */
export interface TicketToolPorts {
  store: TicketStore;
  roleOf(agentId: string): ForkRole | null;
  /** The agent, or null when it does not exist or is hidden. */
  agent(agentId: string): { id: string; name: string } | null;
  /** The thread keys and the source key of the caller's current turn: its messaging link, its delivery. */
  turnOrigin(): {
    threadKeys: string[];
    sourceKey: string | null;
    source: TicketSource;
    /** The person whose message started the turn, for the mandate (item 3.4). */
    sender: { platform: string; authorId: string } | null;
  };
  /** The gate of a chat platform now, for the mandate (item 3.4). */
  gate(platform: string): PlatformGate | null;
  /** Queues the work in a side thread of the worker and returns that thread's task id. */
  startWorkerTask(input: TicketWorkerTaskInput): Effect.Effect<{ taskId: string }, unknown>;
  /** Whether a task is still open, so a follow-up can reuse it. */
  taskOpen(taskId: string): boolean;
}

export type TicketToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

function resolve(store: TicketStore, ref: number | string): Ticket {
  const ticket =
    typeof ref === "number"
      ? store.byNumber(ref)
      : /^\d+$/u.test(ref)
        ? store.byNumber(Number(ref))
        : store.get(ref.replace(/^#/u, ""));
  if (!ticket) throw new TicketError("not-found", `There is no ticket ${ref}.`);
  return ticket;
}

/** The fields a model needs; the brief stays out of lists. */
function view(ticket: Ticket, agentName: (id: string) => string | null) {
  return {
    ticket: ticket.number,
    id: ticket.ticketId,
    title: ticket.title,
    state: ticket.state,
    assignee: ticket.assigneeAgentId ? { id: ticket.assigneeAgentId, name: agentName(ticket.assigneeAgentId) } : null,
    summary: ticket.summary,
    humanAction: ticket.humanAction,
    t3ThreadId: ticket.t3ThreadId,
    updatedAt: ticket.updatedAt,
  };
}

/** The first message of a worker's ticket thread. The worker cannot see the Router's chat. */
export function workerBrief(ticket: Ticket, note: string | null): string {
  return [
    `Ticket #${ticket.number}: ${ticket.title}`,
    "",
    ticket.brief,
    ...(note ? ["", `Note from the Router: ${note}`] : []),
    "",
    `You work on ticket #${ticket.number} in this side thread. Do not talk with people directly: the Router does. Report with openbot.ticket_report (ticket ${ticket.number}) when the state changes: review or done with the result and its evidence, blocked or failed with the cause, or awaiting_human with the one decision a person must make. Then end your turn with the same result in plain words.`,
  ].join("\n");
}

function followUp(ticket: Ticket, note: string): string {
  return `Follow-up on ticket #${ticket.number} (${ticket.title}):\n\n${note}\n\nReport the new state with openbot.ticket_report when it changes.`;
}

/** Runs one ticket tool for `callerId`. Errors that the caller can fix come back as `{ ok: false }`. */
export const handleTicketTool = Effect.fn("TicketTools.handle")(function* (
  ports: TicketToolPorts,
  tool: TicketToolName,
  args: unknown,
  callerId: string,
): Effect.fn.Return<TicketToolOutcome, unknown> {
  const parsed = schemas[tool].safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: `Invalid ${tool} input: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}.`,
    };
  const role = ports.roleOf(callerId);
  const name = (id: string) => ports.agent(id)?.name ?? null;
  const routerOnly = () =>
    role === "router" ? null : `${tool} is for the Router. Report your own ticket with ticket_report.`;
  try {
    switch (tool) {
      case "ticket_create": {
        const refused = routerOnly();
        if (refused) return { ok: false, error: refused };
        const input = schemas.ticket_create.parse(args);
        const origin = ports.turnOrigin();
        const { ticket, created } = ports.store.create({
          title: input.title,
          brief: input.brief,
          routerAgentId: callerId,
          source: origin.source,
          sourceKey: origin.sourceKey ? `${origin.sourceKey}:${input.title}` : null,
          threadKeys: origin.threadKeys,
          actor: callerId,
        });
        if (created)
          ports.store.setMandate(
            ticket.ticketId,
            buildMandate(origin, origin.sender ? ports.gate(origin.sender.platform) : null, input.scope ?? input.title),
            "host",
          );
        if (!input.assignTo || !created || ticket.state !== "open")
          return { ok: true, value: { created, ...view(ticket, name) } };
        return yield* assign(ports, ticket, input.assignTo, null, callerId, name);
      }
      case "ticket_assign": {
        const input = schemas.ticket_assign.parse(args);
        const ticket = resolve(ports.store, input.ticket);
        // The Watchdog may resume a ticket with its own worker; only the Router gives work to another one.
        const watchdogResume = role === "watchdog" && ticket.assigneeAgentId === input.agentId;
        const refused = watchdogResume ? null : routerOnly();
        if (refused) return { ok: false, error: refused };
        // Fork (item 5.5): the Watchdog resumes a failed ticket a few times at most; then the Router decides.
        if (
          role === "watchdog" &&
          ticket.state === "failed" &&
          watchdogRetries(ports.store, ticket.ticketId, (id) => ports.roleOf(id) === "watchdog") >= MAX_WATCHDOG_RETRIES
        )
          return {
            ok: false,
            error: `Ticket #${ticket.number} was resumed ${MAX_WATCHDOG_RETRIES} times after a failure. Tell the Router with openbot.send_message; it decides whether to try again.`,
          };
        return yield* assign(ports, ticket, input.agentId, input.note ?? null, callerId, name);
      }
      case "ticket_note": {
        if (role !== "router" && role !== "watchdog")
          return { ok: false, error: "ticket_note is for the Router and the Watchdog." };
        const input = schemas.ticket_note.parse(args);
        const ticket = resolve(ports.store, input.ticket);
        ports.store.note(ticket.ticketId, callerId, input.note);
        return { ok: true, value: { ticket: ticket.number, noted: true } };
      }
      case "ticket_list": {
        const input = schemas.ticket_list.parse(args);
        const own = role === "router" || role === "watchdog" ? {} : { assigneeAgentId: callerId };
        const tickets = ports.store.list({
          ...own,
          ...(input.states ? { states: input.states } : {}),
          limit: input.limit ?? 30,
        });
        return { ok: true, value: { tickets: tickets.map((ticket) => view(ticket, name)) } };
      }
      case "ticket_read": {
        const input = schemas.ticket_read.parse(args);
        const ticket = resolve(ports.store, input.ticket);
        if (role !== "router" && role !== "watchdog" && ticket.assigneeAgentId !== callerId)
          return { ok: false, error: `Ticket #${ticket.number} is not assigned to you.` };
        return {
          ok: true,
          value: {
            ...view(ticket, name),
            brief: ticket.brief,
            threads: ports.store.threadsOf(ticket.ticketId),
            events: ports.store.events(ticket.ticketId, 20),
          },
        };
      }
      case "ticket_report": {
        const input = schemas.ticket_report.parse(args);
        const ticket = resolve(ports.store, input.ticket);
        if (ticket.assigneeAgentId !== callerId)
          return { ok: false, error: `Ticket #${ticket.number} is not assigned to you; only its worker reports it.` };
        if (ticket.state === "cancelled")
          return { ok: false, error: `Ticket #${ticket.number} was cancelled by a person. Stop the work.` };
        const next = ports.store.transition(ticket.ticketId, input.state, {
          actor: callerId,
          summary: input.summary,
          humanAction: input.humanAction ?? null,
        });
        return { ok: true, value: view(next, name) };
      }
      case "ticket_close": {
        const refused = routerOnly();
        if (refused) return { ok: false, error: refused };
        const input = schemas.ticket_close.parse(args);
        const ticket = resolve(ports.store, input.ticket);
        const next = ports.store.transition(ticket.ticketId, input.state, { actor: callerId, note: input.note });
        return { ok: true, value: view(next, name) };
      }
    }
  } catch (error) {
    if (error instanceof TicketError) return { ok: false, error: error.message };
    throw error;
  }
});

const assign = Effect.fn("TicketTools.assign")(function* (
  ports: TicketToolPorts,
  ticket: Ticket,
  workerId: string,
  note: string | null,
  callerId: string,
  name: (id: string) => string | null,
): Effect.fn.Return<TicketToolOutcome, unknown> {
  const worker = ports.agent(workerId);
  if (!worker) return { ok: false, error: `There is no agent ${workerId} that can take work.` };
  if (workerId === callerId) return { ok: false, error: "The Router does not take tickets; assign a worker." };
  const workerRole = ports.roleOf(workerId);
  if (workerRole === "router" || workerRole === "watchdog")
    return { ok: false, error: `${worker.name} has the role ${workerRole} and does not take tickets.` };
  if (ticket.state === "cancelled") return { ok: false, error: `Ticket #${ticket.number} was cancelled.` };
  const held = mandateHolds(ticket.mandateJson, (platform) => ports.gate(platform));
  if (!held.ok) {
    ports.store.note(ticket.ticketId, "host", `mandate revoked: ${held.reason}`);
    return {
      ok: false,
      error: `Ticket #${ticket.number} cannot go on: ${held.reason}. Close it with ticket_close (cancelled), and open a new ticket if an allowed person asks again.`,
    };
  }
  // A follow-up to the same worker reuses its open side thread, so the worker keeps its context.
  const sameWorker = ticket.assigneeAgentId === workerId && ticket.taskId !== null && ports.taskOpen(ticket.taskId);
  const reusedTask = sameWorker ? ticket.taskId : null;
  const text = reusedTask && note ? followUp(ticket, note) : workerBrief(ticket, note);
  const { taskId } = yield* ports.startWorkerTask({
    workerAgentId: workerId,
    routerAgentId: callerId,
    taskId: reusedTask,
    title: `#${ticket.number} ${ticket.title}`,
    text,
  });
  const next =
    ticket.state === "working" && sameWorker ? ticket : ports.store.assign(ticket.ticketId, workerId, taskId, callerId);
  if (sameWorker && note) ports.store.note(ticket.ticketId, callerId, `follow-up: ${note}`);
  return {
    ok: true,
    value: {
      ...view(next, name),
      followUp: sameWorker,
      note: "The worker's answer comes back to you. Tell the person in one short line who works on it, then wait.",
    },
  };
});
