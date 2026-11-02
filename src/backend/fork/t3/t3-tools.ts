// Fork module (super-agent, roadmap item 3.1b). The coding executor's tools for the worker of a
// ticket. `t3_run` starts the ticket's T3 Code thread in a new worktree, or sends a follow-up to the
// thread that the ticket already has, waits for the run, and moves the ticket to the state that
// the run came to. `t3_show` reads the thread. The host checks that the caller is the ticket's
// assignee; the Router never gets these tools (`router-policy.ts`).

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
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

export const T3_TOOL_NAMES = ["t3_run", "t3_show", "t3_sweep"] as const;
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
const sweepShape = {};

export const T3_TOOL_DEFINITIONS = [
  {
    name: "t3_run",
    description:
      "Worker of a coding ticket. Run the work in T3 Code: the first call starts the ticket's T3 thread in a new git worktree, later calls send a follow-up to the same thread. Waits for the run and updates the ticket: completed → review, waits for a person → awaiting_human, failed → failed, still running → working.",
    shape: runShape,
  },
  {
    name: "t3_show",
    description: "Worker or Watchdog. Read the state and the latest messages of a coding ticket's T3 Code thread.",
    shape: showShape,
  },
  {
    name: "t3_sweep",
    description:
      "Watchdog only. Check the T3 Code thread of every live coding ticket: a thread that waits for a person moves its ticket to awaiting_human; a thread with no active run while its ticket is working, or a failed run, is flagged for you to act on.",
    shape: sweepShape,
  },
] as const;

const schemas = {
  t3_run: z.strictObject(runShape),
  t3_show: z.strictObject(showShape),
  t3_sweep: z.strictObject(sweepShape),
};

/** What T3's `thread show --json` gives for a thread (T3 `OrchestratorMcpThreadDetail`). */
export interface T3ThreadState {
  status: string;
  activeRunId: string | null;
  pendingRequestCount: number;
  settled: boolean;
  pullRequest: string | null;
}

export function t3ThreadState(json: unknown): T3ThreadState | null {
  if (!isDynamicRecord(json) || !isDynamicRecord(json.thread)) return null;
  const thread = json.thread;
  if (typeof thread.status !== "string") return null;
  const pullRequest = thread.linkedPullRequest;
  return {
    status: thread.status,
    activeRunId: typeof thread.activeRunId === "string" ? thread.activeRunId : null,
    pendingRequestCount: typeof thread.pendingRequestCount === "number" ? thread.pendingRequestCount : 0,
    settled: thread.settled === true,
    pullRequest: isDynamicRecord(pullRequest) && typeof pullRequest.url === "string" ? pullRequest.url : null,
  };
}

export type T3SweepFlag = "waits_for_person" | "idle_while_working" | "run_failed" | "running" | "ok" | "unreadable";

/** What a T3 thread's state means for its ticket. */
export function sweepFlag(ticket: Ticket, state: T3ThreadState | null): T3SweepFlag {
  if (!state) return "unreadable";
  if (state.pendingRequestCount > 0) return "waits_for_person";
  if (state.activeRunId !== null) return "running";
  if (state.status === "failed" || state.status === "interrupted")
    return ticket.state === "working" ? "run_failed" : "ok";
  return ticket.state === "working" ? "idle_while_working" : "ok";
}

const T3_QUESTION =
  "T3 Code asks a question in its thread. Answer it in the T3 Code app or web (t3_run only queues a next turn and does not answer the open question).";

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
        ? `${T3_QUESTION} Thread: ${outcome.threadId ?? ticket.t3ThreadId ?? "unknown"}.`
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
  const role = ports.roleOf(callerId);
  if (role === "router") return { ok: false, error: "The Router does not run code; assign a ticket." };
  try {
    const config = ports.settings();
    if (tool === "t3_sweep") {
      if (role !== "watchdog") return { ok: false, error: "t3_sweep is for the Watchdog." };
      return { ok: true, value: yield* sweep(ports, cliSettings(config, 30), callerId) };
    }
    const ref = schemas[tool].parse(args).ticket;
    const ticket = resolve(ports.store, ref);
    if (ticket.assigneeAgentId !== callerId && !(tool === "t3_show" && role === "watchdog"))
      return { ok: false, error: `Ticket #${ticket.number} is not assigned to you.` };
    const settings = cliSettings(config, tool === "t3_show" ? 30 : undefined);
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

/** Checks the T3 thread of each live coding ticket, for the Watchdog (item 3.1c). */
const sweep = Effect.fn("T3Tools.sweep")(function* (ports: T3ToolPorts, settings: T3Settings, callerId: string) {
  const live = ports.store
    .list({ states: ["working", "awaiting_human", "review", "blocked"], limit: 50 })
    .filter((ticket) => ticket.t3ThreadId !== null)
    .slice(0, 20);
  const rows = [];
  for (const ticket of live) {
    const result = yield* safely(ports.call(settings, t3Args.show(settings, ticket.t3ThreadId ?? "")));
    const state = result.exitCode === 0 ? t3ThreadState(parseT3Json(result.stdout)) : null;
    const flag = sweepFlag(ticket, state);
    const current =
      flag === "waits_for_person" && ticket.state === "working"
        ? ports.store.transition(ticket.ticketId, "awaiting_human", {
            actor: callerId,
            humanAction: `${T3_QUESTION} Thread: ${ticket.t3ThreadId}.`,
          })
        : ticket;
    rows.push({
      ticket: ticket.number,
      title: ticket.title,
      state: current.state,
      assignee: ticket.assigneeAgentId,
      t3ThreadId: ticket.t3ThreadId,
      flag,
      t3: state,
    });
  }
  return { checked: rows.length, tickets: rows };
});
