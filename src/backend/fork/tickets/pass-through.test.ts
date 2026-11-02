import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messagingThreadKey, passThroughText, passThroughTicket } from "./pass-through";
import { TicketStore } from "./ticket-store";

let dir: string;
let store: TicketStore;
let open: Set<string>;
const ports = () => ({
  store,
  roleOf: (id: string) => (id === "router" ? ("router" as const) : null),
  taskOpen: (taskId: string) => open.has(taskId),
});
const group = { routerAgentId: "router", linkId: "link-1", isDirect: false };

function assigned(title: string, taskId: string, linkId = "link-1") {
  const { ticket } = store.create({
    title,
    brief: "b",
    routerAgentId: "router",
    source: "messaging",
    threadKeys: [messagingThreadKey(linkId)],
  });
  open.add(taskId);
  return store.assign(ticket.ticketId, "coder", taskId, "router");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-pass-through-"));
  store = new TicketStore({ userDataPath: dir });
  open = new Set();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("passThroughTicket", () => {
  it("passes a group follow-up to the one live ticket of the conversation", () => {
    const ticket = assigned("Fix login", "task-1");
    expect(passThroughTicket(ports(), group)?.ticketId).toBe(ticket.ticketId);
  });

  it("leaves a private chat, another agent, or no ticket to the Router", () => {
    assigned("Fix login", "task-1");
    expect(passThroughTicket(ports(), { ...group, isDirect: true })).toBeNull();
    expect(passThroughTicket(ports(), { ...group, routerAgentId: "someone" })).toBeNull();
    expect(passThroughTicket(ports(), { ...group, linkId: "link-2" })).toBeNull();
  });

  it("leaves the message to the Router when two live tickets share the conversation", () => {
    assigned("A", "task-1");
    assigned("B", "task-2");
    expect(passThroughTicket(ports(), group)).toBeNull();
  });

  it("ignores ended, unassigned, and closed-thread tickets", () => {
    const done = assigned("A", "task-1");
    store.transition(done.ticketId, "done", { actor: "coder" });
    expect(passThroughTicket(ports(), group)).toBeNull();
    store.create({
      title: "open",
      brief: "b",
      routerAgentId: "router",
      source: "messaging",
      threadKeys: ["messaging:link-1"],
    });
    expect(passThroughTicket(ports(), group)).toBeNull();
    const live = assigned("C", "task-3");
    open.delete("task-3");
    expect(passThroughTicket(ports(), group)).toBeNull();
    open.add("task-3");
    expect(passThroughTicket(ports(), group)?.ticketId).toBe(live.ticketId);
  });

  it("passes a person's answer to a ticket that waits for it", () => {
    const ticket = assigned("A", "task-1");
    store.transition(ticket.ticketId, "awaiting_human", { actor: "coder", humanAction: "A or B?" });
    const passed = passThroughTicket(ports(), group);
    expect(passed?.state).toBe("awaiting_human");
    if (passed)
      expect(passThroughText(passed, "Fikri", "B please")).toContain(
        "This can be the answer to your question: A or B?",
      );
  });
});

describe("passThroughText", () => {
  it("names the ticket, the author and the way back", () => {
    const ticket = assigned("Fix login", "task-1");
    const text = passThroughText(ticket, "Fikri", "Also check Android.");
    expect(text).toContain("ticket #1 (Fix login)");
    expect(text).toContain("Fikri");
    expect(text).toContain("Also check Android.");
    expect(text).toContain("the Router sees your answer");
  });
});
