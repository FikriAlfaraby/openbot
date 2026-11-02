// Fork module (super-agent, roadmap item 3.1). Runs T3 Code's `t3 thread` CLI on the host, the
// executor of coding tickets. Read from T3 Code's source (`apps/server/src/cli/thread.ts`,
// `docs/user/outside-agents.md`, 2026-11-02):
//
// - `t3 thread start <project> <message> [--worktree <base>] [--branch <name>] [--title <t>]
//    [--wait] [--json]` launches a thread; `t3 thread send <thread> <message> [--wait] [--json]`
//    queues a message (never interrupts); `t3 thread show <thread> [--json]` reads the state.
// - Without `--wait`, `--json` prints the launch or send result. With `--wait --json`, stdout gets
//   `{ threadId, runId, status, reply, error }` also when the run fails.
// - Exit 0: the run completed. Exit 2: the thread waits for a person's answer. Exit 1: the run
//   stopped or failed, or the CLI failed (server not running, unknown project).
// - On the machine that runs T3 Code, `t3 thread` needs no sign-in. `--base-dir` names another T3
//   home, for a T3 server of another user.

import { execFile } from "node:child_process";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { TicketState } from "../tickets/ticket-store";

export interface T3Settings {
  /** The command and its first arguments, such as `["t3"]` or `["sudo", "-u", "t3", "t3"]`. */
  command: readonly string[];
  /** T3 Code's home folder, for `--base-dir`; null for the default of the user that runs it. */
  baseDir: string | null;
  /** The project: an id or a path inside it. */
  project: string;
  /** How long one call may take. A `--wait` call should stay below the caller's own deadline. */
  timeoutMs: number;
}

export const DEFAULT_T3_SETTINGS: T3Settings = { command: ["t3"], baseDir: null, project: ".", timeoutMs: 120_000 };

/** The output of one CLI call. */
export interface T3CallResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type T3Outcome =
  /** The run completed with this reply. */
  | { kind: "completed"; threadId: string; runId: string | null; reply: string | null }
  /** The thread waits for a person's answer. */
  | { kind: "needs_input"; threadId: string | null }
  /** Started or queued without waiting. */
  | { kind: "started"; threadId: string; runId: string | null }
  /** The run stopped or failed, or the CLI could not do the call. */
  | { kind: "failed"; threadId: string | null; status: string; error: string };

const MAX_MESSAGE = 100_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function baseDirArgs(settings: T3Settings): string[] {
  return settings.baseDir ? ["--base-dir", settings.baseDir] : [];
}

function message(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A T3 message needs text.");
  if (trimmed.length > MAX_MESSAGE) throw new Error(`A T3 message has at most ${MAX_MESSAGE} characters.`);
  return trimmed;
}

/** A git ref or branch name; T3 passes it to git, so only plain names are accepted. */
function refName(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(value) || value.includes(".."))
    throw new Error(`${field} must be a plain branch, tag or commit name.`);
  return value;
}

export interface T3StartInput {
  message: string;
  title?: string;
  /** Run in a new worktree based on this ref. */
  worktree?: string;
  branch?: string;
  wait: boolean;
}

export const t3Args = {
  start(settings: T3Settings, input: T3StartInput): string[] {
    if (input.branch && !input.worktree) throw new Error("--branch needs --worktree.");
    return [
      "thread",
      "start",
      ...baseDirArgs(settings),
      ...(input.title ? ["--title", input.title.slice(0, 80)] : []),
      ...(input.worktree ? ["--worktree", refName(input.worktree, "worktree")] : []),
      ...(input.branch ? ["--branch", refName(input.branch, "branch")] : []),
      ...(input.wait ? ["--wait"] : []),
      "--json",
      // `--` keeps a message that starts with a dash from reading as a flag.
      "--",
      settings.project,
      message(input.message),
    ];
  },
  send(settings: T3Settings, threadId: string, text: string, wait: boolean): string[] {
    return [
      "thread",
      "send",
      ...baseDirArgs(settings),
      ...(wait ? ["--wait"] : []),
      "--json",
      "--",
      threadId,
      message(text),
    ];
  },
  show(settings: T3Settings, threadId: string): string[] {
    return ["thread", "show", ...baseDirArgs(settings), "--messages", "3", "--json", "--", threadId];
  },
};

/** The last line of stdout that is a JSON object. */
export function parseT3Json(stdout: string): DynamicRecord | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value = JSON.parse(text);
      if (isDynamicRecord(value)) return value;
    } catch {
      // Not JSON; a log line.
    }
  }
  return null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** What a `start` or `send` call came to. */
export function t3Outcome(result: T3CallResult): T3Outcome {
  const json = parseT3Json(result.stdout);
  const threadId = text(json?.threadId);
  if (result.timedOut) return { kind: "failed", threadId, status: "timeout", error: "T3 Code did not answer in time." };
  if (result.exitCode === 2) return { kind: "needs_input", threadId };
  if (result.exitCode === 0 && threadId) {
    const status = text(json?.status);
    if (status === null) return { kind: "started", threadId, runId: text(json?.runId) };
    if (status === "completed")
      return { kind: "completed", threadId, runId: text(json?.runId), reply: text(json?.reply) };
    if (status === "waiting") return { kind: "needs_input", threadId };
  }
  const stderr = result.stderr.trim().split("\n").at(-1) ?? "";
  return {
    kind: "failed",
    threadId,
    status: text(json?.status) ?? `exit ${result.exitCode ?? "none"}`,
    error: (text(json?.error) ?? stderr) || "T3 Code failed with no message.",
  };
}

/** The ticket state that a T3 outcome means. A completed run waits for review, not done. */
export function ticketStateFor(outcome: T3Outcome): TicketState {
  switch (outcome.kind) {
    case "completed":
      return "review";
    case "needs_input":
      return "awaiting_human";
    case "started":
      return "working";
    case "failed":
      return "failed";
  }
}

/** Runs one CLI call. A non-zero exit is a result, not an error; only a spawn failure fails. */
export function runT3(settings: T3Settings, args: readonly string[]): Effect.Effect<T3CallResult, Error> {
  const [file, ...prefix] = settings.command;
  if (!file) return Effect.fail(new Error("The T3 command is empty."));
  return Effect.callback<T3CallResult, Error>((resume) => {
    const child = execFile(
      file,
      [...prefix, ...args],
      { timeout: settings.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && "code" in error && typeof error.code === "string" && error.code === "ENOENT") {
          resume(Effect.fail(new Error(`The T3 command ${file} is not installed or not on PATH.`)));
          return;
        }
        const timedOut = Boolean(error && "killed" in error && error.killed);
        const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resume(Effect.succeed({ exitCode, stdout: String(stdout), stderr: String(stderr), timedOut }));
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });
}
