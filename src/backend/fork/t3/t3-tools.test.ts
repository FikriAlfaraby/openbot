import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseForkConfig } from "../fork-config";
import { TicketStore } from "../tickets/ticket-store";
import type { T3CallResult } from "./t3-cli";
import { cliSettings, handleT3Tool, type T3ToolPorts } from "./t3-tools";

let dir: string;
let store: TicketStore;
let calls: string[][];
let next: T3CallResult;
const json = (value: unknown, exitCode = 0): T3CallResult => ({
  exitCode,
  stdout: `${JSON.stringify(value)}\n`,
  stderr: "",
  timedOut: false,
});

const ports = (): T3ToolPorts => ({
  store,
  roleOf: (id) => (id === "router" ? "router" : id === "coder" ? "worker" : null),
  settings: () => ({ command: ["t3"], project: "/srv/app", baseBranch: "develop", waitSeconds: 60 }),
  call: (_settings, args) =>
    Effect.sync(() => {
      calls.push([...args]);
      return next;
    }),
});

const run = (args: unknown, caller = "coder") => Effect.runPromise(handleT3Tool(ports(), "t3_run", args, caller));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-t3-tools-"));
  store = new TicketStore({ userDataPath: dir });
  calls = [];
  const { ticket } = store.create({ title: "Fix login", brief: "b", routerAgentId: "router", source: "agent" });
  store.assign(ticket.ticketId, "coder", "task-1", "router");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("t3_run", () => {
  it("starts the ticket's thread in a worktree and moves a completed run to review", async () => {
    next = json({ threadId: "t3-thread-1", runId: "r1", status: "completed", reply: "PR #57", error: null });
    const result = await run({ ticket: 1, message: "Fix the token refresh and run the tests." });
    expect(calls[0]).toEqual([
      "thread",
      "start",
      "--title",
      "#1 Fix login",
      "--worktree",
      "develop",
      "--wait",
      "--json",
      "--",
      "/srv/app",
      "Fix the token refresh and run the tests.",
    ]);
    expect(result).toMatchObject({ ok: true, value: { state: "review", t3ThreadId: "t3-thread-1" } });
    expect(store.byNumber(1)?.summary).toBe("T3 Code finished: PR #57");
  });

  it("sends a follow-up to the same thread", async () => {
    next = json({ threadId: "t3-thread-1", runId: "r1", status: "completed", reply: "done", error: null });
    await run({ ticket: 1, message: "first" });
    await run({ ticket: 1, message: "Also cover Android." });
    expect(calls[1]).toEqual(["thread", "send", "--wait", "--json", "--", "t3-thread-1", "Also cover Android."]);
    expect(store.byNumber(1)?.state).toBe("review");
  });

  it("moves a thread that waits for a person to awaiting_human", async () => {
    next = json({ threadId: "t3-thread-1", runId: "r1", status: "waiting", reply: null, error: null }, 2);
    const result = await run({ ticket: 1, message: "Do it" });
    expect(result).toMatchObject({ ok: true, value: { state: "awaiting_human" } });
    expect(store.byNumber(1)?.humanAction).toContain("t3-thread-1");
  });

  it("keeps a run that outlasts the wait in working, and fails a failed run with the reason", async () => {
    next = { exitCode: null, stdout: "", stderr: "", timedOut: true };
    expect(await run({ ticket: 1, message: "long" })).toMatchObject({ ok: true, value: { state: "working" } });
    next = json({ threadId: "t3-thread-1", runId: "r2", status: "failed", reply: null, error: "tests failed" }, 1);
    expect(await run({ ticket: 1, message: "again" })).toMatchObject({ ok: true, value: { state: "failed" } });
    expect(store.byNumber(1)?.summary).toContain("tests failed");
  });

  it("refuses the Router, another agent, a cancelled ticket and an unsafe base branch", async () => {
    next = json({ threadId: "t", runId: "r", status: "completed", reply: "", error: null });
    expect(await run({ ticket: 1, message: "x" }, "router")).toMatchObject({ ok: false });
    expect(await run({ ticket: 1, message: "x" }, "researcher")).toMatchObject({ ok: false });
    expect(await run({ ticket: 1, message: "x", baseBranch: "main; rm -rf /" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("plain"),
    });
    store.transition(store.byNumber(1)?.ticketId ?? "", "cancelled", { actor: "person" });
    expect(await run({ ticket: 1, message: "x" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
    expect(calls).toHaveLength(0);
  });
});

describe("t3_show", () => {
  it("needs a thread, then reads it", async () => {
    expect(await Effect.runPromise(handleT3Tool(ports(), "t3_show", { ticket: 1 }, "coder"))).toMatchObject({
      ok: false,
    });
    next = json({ threadId: "t3-thread-1", runId: "r1", status: "completed", reply: "ok", error: null });
    await run({ ticket: 1, message: "go" });
    next = json({ thread: { threadId: "t3-thread-1", status: "idle" }, messages: [] });
    expect(await Effect.runPromise(handleT3Tool(ports(), "t3_show", { ticket: 1 }, "coder"))).toMatchObject({
      ok: true,
      value: { thread: { status: "idle" } },
    });
  });
});

describe("T3 settings", () => {
  it("reads the t3 block of fork-config.yaml and gives defaults", () => {
    const parsed = parseForkConfig(
      "version: 1\nt3:\n  command: [sudo, -u, t3, t3]\n  project: /srv/app\n  waitSeconds: 900\n",
    );
    expect(parsed.ok && parsed.config.t3).toEqual({
      command: ["sudo", "-u", "t3", "t3"],
      project: "/srv/app",
      waitSeconds: 900,
    });
    expect(parseForkConfig("version: 1\nt3:\n  waitSeconds: 5\n").ok).toBe(false);
    expect(cliSettings(null)).toEqual({ command: ["t3"], baseDir: null, project: ".", timeoutMs: 605_000 });
  });
});
