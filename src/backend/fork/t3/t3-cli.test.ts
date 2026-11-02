import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_T3_SETTINGS, parseT3Json, runT3, type T3Settings, t3Args, t3Outcome, ticketStateFor } from "./t3-cli";

// A fake `t3`: the message picks the outcome, as the real CLI's exit codes and JSON do.
const FAKE = `
const args = process.argv.slice(2);
const end = args.indexOf("--");
const [ , command ] = args;
const operands = args.slice(end + 1);
const wait = args.includes("--wait");
const text = operands[operands.length - 1] ?? "";
if (command === "show") { console.log(JSON.stringify({ thread: { threadId: operands[0], status: "idle" }, messages: [] })); process.exit(0); }
const threadId = command === "send" ? operands[0] : "thread-42";
if (text.includes("server-down")) { console.error("T3 Code is not running."); process.exit(1); }
if (text.includes("slow")) { setTimeout(() => {}, 10000); return; }
if (!wait) { console.log(JSON.stringify({ threadId, runId: "run-1", projectId: "p" })); process.exit(0); }
if (text.includes("ask")) { console.log(JSON.stringify({ threadId, runId: "run-1", status: "waiting", reply: null, error: null })); process.exit(2); }
if (text.includes("break")) { console.log(JSON.stringify({ threadId, runId: "run-1", status: "failed", reply: null, error: "tests failed" })); process.exit(1); }
console.log("log line");
console.log(JSON.stringify({ threadId, runId: "run-1", status: "completed", reply: "PR #57 opened", error: null }));
process.exit(0);
`;

let dir: string;
let settings: T3Settings;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-t3-"));
  const script = join(dir, "fake-t3.cjs");
  writeFileSync(script, `(function(){${FAKE}})();`);
  settings = { command: [process.execPath, script], baseDir: null, project: "/srv/app", timeoutMs: 5_000 };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const start = (message: string, wait = true, extra: Partial<T3Settings> = {}) =>
  Effect.runPromise(
    runT3({ ...settings, ...extra }, t3Args.start({ ...settings, ...extra }, { message, wait, worktree: "main" })),
  ).then(t3Outcome);

describe("t3Args", () => {
  it("builds start, send and show calls with the message after --", () => {
    expect(
      t3Args.start(
        { ...DEFAULT_T3_SETTINGS, baseDir: "/home/t3/.t3" },
        { message: "-x fix", wait: true, worktree: "main", branch: "fix/login" },
      ),
    ).toEqual([
      "thread",
      "start",
      "--base-dir",
      "/home/t3/.t3",
      "--worktree",
      "main",
      "--branch",
      "fix/login",
      "--wait",
      "--json",
      "--",
      ".",
      "-x fix",
    ]);
    expect(t3Args.send(DEFAULT_T3_SETTINGS, "t1", "next", false)).toEqual([
      "thread",
      "send",
      "--json",
      "--",
      "t1",
      "next",
    ]);
    expect(t3Args.show(DEFAULT_T3_SETTINGS, "t1")).toEqual(["thread", "show", "--messages", "3", "--json", "--", "t1"]);
  });

  it("refuses unsafe refs, an empty message and a branch without a worktree", () => {
    expect(() => t3Args.start(DEFAULT_T3_SETTINGS, { message: "x", wait: false, worktree: "main;rm -rf" })).toThrow(
      "plain",
    );
    expect(() => t3Args.start(DEFAULT_T3_SETTINGS, { message: "x", wait: false, worktree: "../up" })).toThrow("plain");
    expect(() => t3Args.start(DEFAULT_T3_SETTINGS, { message: "  ", wait: false })).toThrow("needs text");
    expect(() => t3Args.start(DEFAULT_T3_SETTINGS, { message: "x", wait: false, branch: "b" })).toThrow("--worktree");
  });
});

describe("parseT3Json", () => {
  it("takes the last JSON object line", () => {
    expect(parseT3Json('log\n{"threadId":"a"}\n{"threadId":"b"}\n')).toEqual({ threadId: "b" });
    expect(parseT3Json("no json")).toBeNull();
  });
});

describe("runT3 with a fake t3", () => {
  it("maps a completed run to review", async () => {
    const outcome = await start("fix the login");
    expect(outcome).toEqual({ kind: "completed", threadId: "thread-42", runId: "run-1", reply: "PR #57 opened" });
    expect(ticketStateFor(outcome)).toBe("review");
  });

  it("maps exit 2 to awaiting_human", async () => {
    const outcome = await start("please ask me");
    expect(outcome).toEqual({ kind: "needs_input", threadId: "thread-42" });
    expect(ticketStateFor(outcome)).toBe("awaiting_human");
  });

  it("maps a failed run and a CLI failure to failed, with the reason", async () => {
    expect(await start("break it")).toMatchObject({ kind: "failed", threadId: "thread-42", error: "tests failed" });
    expect(await start("server-down")).toMatchObject({
      kind: "failed",
      threadId: null,
      error: "T3 Code is not running.",
    });
  });

  it("maps a start without waiting to working", async () => {
    const outcome = await start("fix", false);
    expect(outcome).toEqual({ kind: "started", threadId: "thread-42", runId: "run-1" });
    expect(ticketStateFor(outcome)).toBe("working");
  });

  it("reports a timeout", async () => {
    expect(await start("slow", true, { timeoutMs: 300 })).toMatchObject({ kind: "failed", status: "timeout" });
  });

  it("fails when the command is missing", async () => {
    await expect(
      Effect.runPromise(runT3({ ...settings, command: ["t3-not-installed-xyz"] }, ["thread"])),
    ).rejects.toThrow("not installed");
  });
});
