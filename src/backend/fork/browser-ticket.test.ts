import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentBrowserSessionKey, browserTabPartition } from "../browser-state";
import {
  liveTicketOfTask,
  sweepTicketBrowserSessions,
  ticketBrowserSession,
  usesTicketSession,
} from "./browser-ticket";
import { TicketStore } from "./tickets/ticket-store";

let dir: string;
let store: TicketStore;

function assigned(title: string) {
  const { ticket } = store.create({ title, brief: "b", routerAgentId: "router", source: "agent", sourceKey: title });
  store.assign(ticket.ticketId, "coder", `task-${title}`, "router");
  return ticket;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-browser-ticket-"));
  store = new TicketStore({ userDataPath: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ticket browser session", () => {
  it("is an agent-kind session of its own per ticket, apart from the agent's", () => {
    const one = ticketBrowserSession("ticket-1");
    const two = ticketBrowserSession("ticket-2");
    expect(one).toEqual(ticketBrowserSession("ticket-1"));
    expect(browserTabPartition(one)).not.toBe(browserTabPartition(two));
    expect(one).not.toEqual({ kind: "agent", key: agentBrowserSessionKey("coder") });
    expect(browserTabPartition(one)).toMatch(/^openbot-browser-agent-[0-9a-f]{32}$/u);
  });

  it("is used for a live ticket unless the owner chose a named profile", () => {
    expect(usesTicketSession({ kind: "shared" }, "ticket-1")).toBe(true);
    expect(usesTicketSession({ kind: "agent" }, "ticket-1")).toBe(true);
    expect(usesTicketSession({ kind: "profile", profileId: "work" }, "ticket-1")).toBe(false);
    expect(usesTicketSession({ kind: "agent" }, null)).toBe(false);
  });

  it("finds the live ticket of a worker's task, not an ended one", () => {
    const ticket = assigned("fix login");
    expect(liveTicketOfTask(store, "task-fix login")).toBe(ticket.ticketId);
    expect(liveTicketOfTask(store, "task-other")).toBeNull();
    expect(liveTicketOfTask(store, null)).toBeNull();
    store.transition(ticket.ticketId, "done", { actor: "coder" });
    expect(liveTicketOfTask(store, "task-fix login")).toBeNull();
  });
});

describe("sweepTicketBrowserSessions", () => {
  it("clears each ended ticket once and tries a failed one again", async () => {
    const done = assigned("done one");
    const failing = assigned("busy one");
    const live = assigned("live one");
    store.transition(done.ticketId, "done", { actor: "coder" });
    store.transition(failing.ticketId, "cancelled", { actor: "router" });
    const calls: string[] = [];
    let busy = true;
    const clear = (ticketId: string) =>
      Effect.suspend(() => {
        calls.push(ticketId);
        return ticketId === failing.ticketId && busy ? Effect.fail(new Error("in use")) : Effect.void;
      });
    const cleared = new Set<string>();
    expect(await Effect.runPromise(sweepTicketBrowserSessions(store, clear, cleared))).toEqual([done.ticketId]);
    expect(calls.sort()).toEqual([done.ticketId, failing.ticketId].sort());
    busy = false;
    calls.length = 0;
    expect(await Effect.runPromise(sweepTicketBrowserSessions(store, clear, cleared))).toEqual([failing.ticketId]);
    expect(calls).toEqual([failing.ticketId]);
    expect(calls).not.toContain(live.ticketId);
  });
});
