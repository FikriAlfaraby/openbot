// Fork module (super-agent, roadmap item 3.1b). The coding executor's tools for the worker of a
// ticket. `t3_run` starts the ticket's T3 Code thread in a new worktree, or sends a follow-up to the
// thread that the ticket already has, waits for the run, and moves the ticket to the state that
// the run came to. `t3_show` reads the thread. The host checks that the caller is the ticket's
// assignee; the Router never gets these tools (`router-policy.ts`).

import { Effect } from "effect";
import { z } from "zod";
import type { ForkRole, ForkT3Settings } from "../fork-config";
import { type Ticket, TicketError, type TicketStore } from "../tickets/ticket-store";
import {
  DEFAULT_T3_SETTINGS,
  parseT3Json,
  type T3CallResult,
  type T3Outcome,
  type T3Settings,
  t3Args,
  t3Outcome,
  ticketStateFor,
} from "./t3-cli";

export const T3_TOOL_NAMES = ["t3_run", "t3_show"] as const;
export type T3ToolName = (typeof T3_TOOL_NAMES)[number];

export function isT3Tool(name: string): name is T3ToolName {
  return T3_TOOL_NAMES.some((tool) => tool === name);
}

const DEFAULT_WAIT_SECONDS = 600;

const TicketRef = z.union([z.number().int().min(1), z.string().min(1).max(64)]).describe("Your ticket's number.");

const runShape = {
  ticket: TicketRef,
  message: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "The task for T3 Code: the goal, the files or area, the checks to run, and what done looks like. A follow-up for a ticket that has a T3 thread goes to that thread.",
    ),
  baseBranch: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("For the first run of a ticket: the branch that the new worktree starts from."),
};
const showShape = { ticket: TicketRef };

export const T3_TOOL_DEFINITIONS = [
  {
    name: "t3_run",
    description:
      "Worker of a coding ticket. Run the work in T3 Code: the first call starts the ticket's T3 thread in a new git worktree, later calls send a follow-up to the same thread. Waits for the run and updates the ticket: completed → review, waits for a person → awaiting_human, failed → failed, still running → working.",
    shape: runShape,
  },
  {
    name: "t3_show",
    description: "Worker of a coding ticket. Read the state and the latest messages of the ticket's T3 Code thread.",
    shape: showShape,
  },
] as const;

const schemas = { t3_run: z.strictObject(runShape), t3_show: z.strictObject(showShape) };

export interface T3ToolPorts {
  store: TicketStore;
  roleOf(agentId: string): ForkRole | null;
  settings(): ForkT3Settings | null;
  call(settings: T3Settings, args: readonly string[]): Effect.Effect<T3CallResult, Error>;
}

export type T3ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** A CLI that cannot start is a failed call, which the worker can read and report. */
const safely = (call: Effect.Effect<T3CallResult, Error>): Effect.Effect<T3CallResult> =>
  call.pipe(
    Effect.catch((error) => Effect.succeed({ exitCode: null, stdout: "", stderr: error.message, timedOut: false })),
  );

/** The CLI settings from `fork-config.yaml`, with the defaults. */
export function cliSettings(config: ForkT3Settings | null, waitSeconds?: number): T3Settings {
  return {
    command: config?.command ?? DEFAULT_T3_SETTINGS.command,
    baseDir: config?.baseDir ?? null,
    project: config?.project ?? DEFAULT_T3_SETTINGS.project,
    // The CLI gets a few seconds more than the wait, so a long run reads as "still running", not a kill.
    timeoutMs: ((waitSeconds ?? config?.waitSeconds ?? DEFAULT_WAIT_SECONDS) + 5) * 1000,
  };
}

function resolve(store: TicketStore, ref: number | string): Ticket {
  const ticket = typeof ref === "number" || /^\d+$/u.test(ref) ? store.byNumber(Number(ref)) : store.get(ref);
  if (!ticket) throw new TicketError("not-found", `There is no ticket ${ref}.`);
  return ticket;
}

/** The ticket state and the texts for an outcome. A wait that ran out is a run that goes on. */
function applyOutcome(store: TicketStore, ticket: Ticket, outcome: T3Outcome, callerId: string): Ticket {
  if (outcome.threadId && outcome.threadId !== ticket.t3ThreadId)
    ticket = store.setT3Thread(ticket.ticketId, outcome.threadId, callerId);
  if (outcome.kind === "failed" && outcome.status === "timeout") {
    store.note(ticket.ticketId, callerId, "T3 run still going after the wait");
    return store.get(ticket.ticketId) ?? ticket;
  }
  const state = ticketStateFor(outcome);
  if (state === ticket.state && state === "working") return ticket;
  const summary =
    outcome.kind === "completed"
      ? `T3 Code finished: ${outcome.reply ?? "(no reply text)"}`.slice(0, 4_000)
      : outcome.kind === "failed"
        ? `T3 Code ${outcome.status}: ${outcome.error}`.slice(0, 4_000)
        : null;
  return store.transition(ticket.ticketId, state, {
    actor: callerId,
    summary,
    humanAction:
      outcome.kind === "needs_input"
        ? `T3 Code thread ${outcome.threadId ?? ticket.t3ThreadId ?? ""} waits for an answer. Answer in T3 Code, or tell the Router and the worker passes it on with t3_run.`
        : null,
  });
}

export const handleT3Tool = Effect.fn("T3Tools.handle")(function* (
  ports: T3ToolPorts,
  tool: T3ToolName,
  args: unknown,
  callerId: string,
): Effect.fn.Return<T3ToolOutcome, unknown> {
  const parsed = schemas[tool].safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      error: `Invalid ${tool} input: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}.`,
    };
  if (ports.roleOf(callerId) === "router")
    return { ok: false, error: "The Router does not run code; assign a ticket." };
  try {
    const ticket = resolve(ports.store, parsed.data.ticket);
    if (ticket.assigneeAgentId !== callerId)
      return { ok: false, error: `Ticket #${ticket.number} is not assigned to you.` };
    const config = ports.settings();
    const settings = cliSettings(config);
    if (tool === "t3_show") {
      if (!ticket.t3ThreadId) return { ok: false, error: `Ticket #${ticket.number} has no T3 thread yet; use t3_run.` };
      const result = yield* safely(ports.call(settings, t3Args.show(settings, ticket.t3ThreadId)));
      if (result.exitCode !== 0)
        return { ok: false, error: result.stderr.trim() || "T3 Code could not show the thread." };
      return { ok: true, value: parseT3Json(result.stdout) ?? { output: result.stdout.slice(0, 8_000) } };
    }
    const input = schemas.t3_run.parse(args);
    if (ticket.state === "cancelled")
      return { ok: false, error: `Ticket #${ticket.number} was cancelled. Stop the work.` };
    const callArgs = ticket.t3ThreadId
      ? t3Args.send(settings, ticket.t3ThreadId, input.message, true)
      : t3Args.start(settings, {
          message: input.message,
          title: `#${ticket.number} ${ticket.title}`,
          worktree: input.baseBranch ?? config?.baseBranch ?? "main",
          wait: true,
        });
    // A ticket that ended or waited moves back to working before the run.
    let current =
      ticket.state === "working" ? ticket : ports.store.transition(ticket.ticketId, "working", { actor: callerId });
    const outcome = t3Outcome(yield* safely(ports.call(settings, callArgs)));
    current = applyOutcome(ports.store, current, outcome, callerId);
    return {
      ok: true,
      value: {
        ticket: current.number,
        state: current.state,
        t3ThreadId: current.t3ThreadId,
        outcome,
        next:
          current.state === "review"
            ? "Check the result (diff, tests, PR), then report done with ticket_report, or run a fix with t3_run."
            : current.state === "awaiting_human"
              ? "End your turn with T3's question in plain words; the Router asks the person."
              : current.state === "working"
                ? "The run goes on in T3 Code. Check it later with t3_show, or wait with openbot.await_event."
                : "Read the error, fix the cause with t3_run, or report blocked with ticket_report.",
      },
    };
  } catch (error) {
    if (error instanceof TicketError) return { ok: false, error: error.message };
    if (error instanceof Error && /plain|needs text|at most|--worktree/u.test(error.message))
      return { ok: false, error: error.message };
    throw error;
  }
});
