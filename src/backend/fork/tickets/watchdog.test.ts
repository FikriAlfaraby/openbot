import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseForkConfig } from "../fork-config";
import { TicketStore } from "./ticket-store";
import { watchdogDue, watchdogFindings, watchdogMessage } from "./watchdog";

let dir: string;
let store: TicketStore;
let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
const now = () => new Date(clock);

function ticket(title: string, state: "working" | "blocked" | "awaiting_human" | "review" | "open") {
  const { ticket: created } = store.create({
    title,
    brief: "b",
    routerAgentId: "router",
    source: "agent",
    sourceKey: title,
  });
  if (state === "open") return created;
  store.assign(created.ticketId, "coder", `task-${title}`, "router");
  if (state === "blocked") store.transition(created.ticketId, "blocked", { actor: "host" });
  if (state === "awaiting_human")
    store.transition(created.ticketId, "awaiting_human", { actor: "coder", humanAction: "A or B?" });
  if (state === "review") store.transition(created.ticketId, "review", { actor: "coder" });
  return created;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-watchdog-"));
  store = new TicketStore({ userDataPath: dir, now });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("watchdogFindings", () => {
  it("counts live tickets and flags blocked ones at once, others after the stale time", () => {
    ticket("open one", "open");
    ticket("working", "working");
    ticket("blocked", "blocked");
    ticket("waits", "awaiting_human");
    ticket("review", "review");
    let result = watchdogFindings(store, 60, now);
    expect(result.live).toBe(4);
    expect(result.findings.map((finding) => [finding.title, finding.flag])).toEqual([["blocked", "blocked"]]);
    clock += 61 * 60_000;
    result = watchdogFindings(store, 60, now);
    expect(Object.fromEntries(result.findings.map((finding) => [finding.title, finding.flag]))).toEqual({
      working: "no_progress",
      blocked: "blocked",
      waits: "waits_long",
      review: "review_waits",
    });
    expect(result.findings.find((finding) => finding.title === "working")?.minutesSinceUpdate).toBe(61);
  });

  it("finds nothing live when all tickets ended", () => {
    const done = ticket("done", "working");
    store.transition(done.ticketId, "done", { actor: "coder" });
    expect(watchdogFindings(store, 60, now)).toEqual({ live: 0, findings: [] });
  });
});

describe("failed tickets (item 5.5)", () => {
  const isWatchdog = (id: string) => id === "watch";

  it("flags a recent failure until the Watchdog acted on it", () => {
    const failed = ticket("deploy", "working");
    store.transition(failed.ticketId, "failed", { actor: "coder", summary: "API error 529" });
    let result = watchdogFindings(store, 60, now, isWatchdog);
    expect(result.live).toBe(0);
    expect(result.findings).toMatchObject([
      { title: "deploy", flag: "failed_recent", watchdogRetries: 0, summary: "API error 529" },
    ]);
    clock += 60_000;
    store.note(failed.ticketId, "watch", "Not transient: the tests fail.");
    result = watchdogFindings(store, 60, now, isWatchdog);
    expect(result.findings).toEqual([]);
  });

  it("drops a failure after a day or after two resumes", () => {
    const old = ticket("old", "working");
    store.transition(old.ticketId, "failed", { actor: "coder" });
    clock += 25 * 60 * 60_000;
    expect(watchdogFindings(store, 60, now, isWatchdog).findings).toEqual([]);
    const retried = ticket("retried", "working");
    for (let attempt = 0; attempt < 2; attempt++) {
      store.transition(retried.ticketId, "failed", { actor: "coder" });
      store.assign(retried.ticketId, "coder", "task-retried", "watch");
    }
    clock += 60_000;
    store.transition(retried.ticketId, "failed", { actor: "coder" });
    expect(watchdogFindings(store, 60, now, isWatchdog).findings).toEqual([]);
  });

  it("asks the Watchdog to judge whether a failure is transient", () => {
    const text = watchdogMessage(0, [
      {
        ticket: 1,
        title: "x",
        state: "failed",
        assignee: "coder",
        t3ThreadId: null,
        minutesSinceUpdate: 3,
        flag: "failed_recent",
        watchdogRetries: 0,
      },
    ]);
    expect(text).toContain("looks transient");
    expect(text).toContain("at most 2 times");
  });
});

describe("watchdogMessage and watchdogDue", () => {
  it("names the tools and stays quiet when all is on track", () => {
    const text = watchdogMessage(2, []);
    expect(text).toContain("2 live ticket(s); 0 look stuck");
    expect(text).toContain("openbot.t3_sweep");
    expect(text).toContain("end without text");
  });

  it("is due first, then after the interval", () => {
    expect(watchdogDue(null, 30, 0)).toBe(true);
    expect(watchdogDue(0, 30, 29 * 60_000)).toBe(false);
    expect(watchdogDue(0, 30, 30 * 60_000)).toBe(true);
  });

  it("reads the watchdog block of fork-config.yaml", () => {
    const parsed = parseForkConfig("version: 1\nwatchdog:\n  everyMinutes: 15\n  staleMinutes: 45\n");
    expect(parsed.ok && parsed.config.watchdog).toEqual({ everyMinutes: 15, staleMinutes: 45 });
    expect(parseForkConfig("version: 1\nwatchdog:\n  everyMinutes: 1\n").ok).toBe(false);
  });
});
