import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TICKET_DATABASE_FILE_NAME, TicketError, TicketStore } from "./ticket-store";

let dir: string;
let store: TicketStore;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++));

const request = (key: string | null = "telegram:chat1:42") =>
  store.create({
    title: "Fix the login bug",
    brief: "The mobile app logs out after one hour.",
    routerAgentId: "router",
    source: "telegram",
    sourceKey: key,
    threadKeys: ["telegram:conn:chat1:dm"],
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-tickets-"));
  store = new TicketStore({ userDataPath: dir, now });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("TicketStore.create", () => {
  it("opens a numbered ticket and logs the creation", () => {
    const { ticket, created } = request();
    expect(created).toBe(true);
    expect(ticket).toMatchObject({ number: 1, state: "open", routerAgentId: "router", assigneeAgentId: null });
    expect(ticket.ticketId).toMatch(/^tkt_[0-9a-f]{32}$/u);
    expect(store.events(ticket.ticketId).map((event) => event.kind)).toEqual(["created", "subscribed"]);
    expect(request(null).ticket.number).toBe(2);
  });

  it("returns the same ticket for the same source message", () => {
    const first = request();
    const again = request();
    expect(again.created).toBe(false);
    expect(again.ticket.ticketId).toBe(first.ticket.ticketId);
    expect(store.list()).toHaveLength(1);
  });

  it("refuses an empty title and text over the limits", () => {
    expect(() => store.create({ title: " ", brief: "", routerAgentId: "r", source: "app" })).toThrow(TicketError);
    expect(() => store.create({ title: "x".repeat(201), brief: "", routerAgentId: "r", source: "app" })).toThrow(
      "title is longer than 200",
    );
  });
});

describe("TicketStore states", () => {
  it("follows the normal life of a ticket", () => {
    const { ticket } = request();
    store.assign(ticket.ticketId, "coder", "task-1", "router");
    expect(store.get(ticket.ticketId)).toMatchObject({ state: "working", assigneeAgentId: "coder", taskId: "task-1" });
    store.transition(ticket.ticketId, "awaiting_human", {
      actor: "coder",
      humanAction: "May I change the user table?",
    });
    expect(store.get(ticket.ticketId)?.humanAction).toBe("May I change the user table?");
    store.transition(ticket.ticketId, "working", { actor: "router", note: "The person said yes." });
    expect(store.get(ticket.ticketId)?.humanAction).toBeNull();
    const done = store.transition(ticket.ticketId, "done", { actor: "coder", summary: "PR #57, 3 tests pass." });
    expect(done).toMatchObject({ state: "done", summary: "PR #57, 3 tests pass." });
    expect(done.endedAt).not.toBeNull();
    expect(store.byTask("task-1")?.ticketId).toBe(ticket.ticketId);
    expect(store.byNumber(1)?.ticketId).toBe(ticket.ticketId);
  });

  it("lets a person's message resume a done ticket, but never a cancelled one", () => {
    const { ticket } = request();
    store.assign(ticket.ticketId, "coder", null, "router");
    store.transition(ticket.ticketId, "done", { actor: "coder" });
    expect(store.transition(ticket.ticketId, "working", { actor: "router" }).endedAt).toBeNull();
    store.transition(ticket.ticketId, "cancelled", { actor: "person" });
    expect(() => store.transition(ticket.ticketId, "working", { actor: "router" })).toThrow(
      "cannot move from cancelled",
    );
    expect(() => store.assign(ticket.ticketId, "coder", null, "router")).toThrow("cannot be assigned");
  });

  it("needs humanAction to wait for a person", () => {
    const { ticket } = request();
    store.assign(ticket.ticketId, "coder", null, "router");
    expect(() => store.transition(ticket.ticketId, "awaiting_human", { actor: "coder" })).toThrow("humanAction");
  });

  it("accepts the same report again without a new event", () => {
    const { ticket } = request();
    store.assign(ticket.ticketId, "coder", null, "router");
    store.transition(ticket.ticketId, "review", { actor: "coder", summary: "first" });
    const count = store.events(ticket.ticketId).length;
    expect(store.transition(ticket.ticketId, "review", { actor: "coder", summary: "second" }).summary).toBe("second");
    expect(store.events(ticket.ticketId)).toHaveLength(count);
  });

  it("refuses a move that the state graph does not have", () => {
    const { ticket } = request();
    expect(() => store.transition(ticket.ticketId, "review", { actor: "coder" })).toThrow("cannot move from open");
    expect(() => store.transition("tkt_missing", "done", { actor: "x" })).toThrow("There is no ticket");
  });

  it("lists by state and assignee, newest first", () => {
    const a = request("a").ticket;
    const b = request("b").ticket;
    store.assign(b.ticketId, "coder", null, "router");
    expect(store.list().map((ticket) => ticket.number)).toEqual([2, 1]);
    expect(store.list({ states: ["open"] }).map((ticket) => ticket.ticketId)).toEqual([a.ticketId]);
    expect(store.list({ assigneeAgentId: "coder" }).map((ticket) => ticket.ticketId)).toEqual([b.ticketId]);
  });
});

describe("TicketStore subscriptions, T3 thread and mandate", () => {
  it("finds the live tickets of a thread", () => {
    const { ticket } = request();
    expect(store.subscribers("telegram:conn:chat1:dm").map((item) => item.ticketId)).toEqual([ticket.ticketId]);
    expect(store.subscribe(ticket.ticketId, "github:pr:57", "coder")).toBe(true);
    expect(store.subscribe(ticket.ticketId, "github:pr:57", "coder")).toBe(false);
    expect(store.threadsOf(ticket.ticketId)).toEqual(["telegram:conn:chat1:dm", "github:pr:57"]);
    expect(store.unsubscribe(ticket.ticketId, "github:pr:57", "coder")).toBe(true);
    store.transition(ticket.ticketId, "cancelled", { actor: "person" });
    expect(store.subscribers("telegram:conn:chat1:dm")).toEqual([]);
  });

  it("records the T3 thread and a mandate once", () => {
    const { ticket } = request();
    expect(store.setT3Thread(ticket.ticketId, "t3-thread-9", "coder").t3ThreadId).toBe("t3-thread-9");
    store.setMandate(ticket.ticketId, { scope: "fix login", strength: "explicit" }, "router");
    expect(JSON.parse(store.get(ticket.ticketId)?.mandateJson ?? "null")).toEqual({
      scope: "fix login",
      strength: "explicit",
    });
    expect(() => store.setMandate(ticket.ticketId, { scope: "more" }, "router")).toThrow("new ticket");
  });
});

describe("TicketStore file", () => {
  it("keeps the tickets across a reopen and refuses a newer schema", () => {
    const { ticket } = request();
    store.close();
    store = new TicketStore({ userDataPath: dir, now });
    expect(store.get(ticket.ticketId)?.title).toBe("Fix the login bug");
    store.close();
    const raw = new DatabaseSync(join(dir, TICKET_DATABASE_FILE_NAME));
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new TicketStore({ userDataPath: dir, now })).toThrow("newer than this build");
    store = new TicketStore({ userDataPath: mkdtempSync(join(tmpdir(), "openbot-tickets-")), now });
  });
});
