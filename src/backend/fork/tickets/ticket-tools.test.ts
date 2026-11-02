import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForkRole } from "../fork-config";
import { TicketStore } from "./ticket-store";
import {
  handleTicketTool,
  isTicketTool,
  TICKET_TOOL_DEFINITIONS,
  type TicketToolName,
  type TicketToolPorts,
  type TicketWorkerTaskInput,
  workerBrief,
} from "./ticket-tools";

let dir: string;
let store: TicketStore;
let started: TicketWorkerTaskInput[];
let openTasks: Set<string>;
const roles: Record<string, ForkRole> = { router: "router", coder: "worker", watch: "watchdog" };
const agents: Record<string, string> = {
  router: "Router",
  coder: "Coder",
  researcher: "Researcher",
  watch: "Watchdog",
};

function ports(origin = { threadKeys: ["messaging:link-1"], sourceKey: "delivery:d1", source: "messaging" as const }) {
  return {
    store,
    roleOf: (id) => roles[id] ?? null,
    agent: (id) => (agents[id] ? { id, name: agents[id] } : null),
    turnOrigin: () => origin,
    taskOpen: (taskId) => openTasks.has(taskId),
    startWorkerTask: (input) =>
      Effect.sync(() => {
        started.push(input);
        const taskId = input.taskId ?? `task-${started.length}`;
        openTasks.add(taskId);
        return { taskId };
      }),
  } satisfies TicketToolPorts;
}

const run = (tool: TicketToolName, args: unknown, caller: string, p: TicketToolPorts = ports()) =>
  Effect.runPromise(handleTicketTool(p, tool, args, caller));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-ticket-tools-"));
  store = new TicketStore({ userDataPath: dir });
  started = [];
  openTasks = new Set();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ticket tool definitions", () => {
  it("names six tools that the router policy allows by prefix", () => {
    expect(TICKET_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "ticket_create",
      "ticket_assign",
      "ticket_list",
      "ticket_read",
      "ticket_report",
      "ticket_close",
    ]);
    expect(isTicketTool("ticket_report")).toBe(true);
    expect(isTicketTool("send_message")).toBe(false);
  });
});

describe("the Router's tools", () => {
  it("creates, assigns and follows up a ticket", async () => {
    const created = await run(
      "ticket_create",
      { title: "Fix login", brief: "Logs out after 1 h.", assignTo: "coder" },
      "router",
    );
    expect(created).toMatchObject({ ok: true, value: { ticket: 1, state: "working", assignee: { id: "coder" } } });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ workerAgentId: "coder", routerAgentId: "router", taskId: null });
    expect(started[0]?.text).toContain("ticket_report (ticket 1)");
    expect(store.threadsOf(store.byNumber(1)?.ticketId ?? "")).toEqual(["messaging:link-1"]);
    // A follow-up to the same worker reuses its side thread.
    const followUp = await run(
      "ticket_assign",
      { ticket: 1, agentId: "coder", note: "Use the staging API." },
      "router",
    );
    expect(followUp).toMatchObject({ ok: true, value: { followUp: true } });
    expect(started[1]).toMatchObject({ taskId: "task-1" });
    expect(started[1]?.text).toContain("Follow-up on ticket #1");
  });

  it("returns the same ticket for a retried create", async () => {
    await run("ticket_create", { title: "Fix login", brief: "x" }, "router");
    const again = await run("ticket_create", { title: "Fix login", brief: "x" }, "router");
    expect(again).toMatchObject({ ok: true, value: { created: false, ticket: 1 } });
  });

  it("refuses the Router's tools for other agents", async () => {
    expect(await run("ticket_create", { title: "x", brief: "y" }, "coder")).toMatchObject({ ok: false });
    expect(await run("ticket_close", { ticket: 1, state: "done", note: "x" }, "researcher")).toMatchObject({
      ok: false,
    });
  });

  it("refuses to assign the Router, the Watchdog or an unknown agent", async () => {
    await run("ticket_create", { title: "x", brief: "y" }, "router");
    for (const agentId of ["router", "watch", "nobody"])
      expect(await run("ticket_assign", { ticket: 1, agentId }, "router")).toMatchObject({ ok: false });
    expect(started).toHaveLength(0);
  });

  it("closes a ticket and refuses work on a cancelled one", async () => {
    await run("ticket_create", { title: "x", brief: "y", assignTo: "coder" }, "router");
    expect(
      await run("ticket_close", { ticket: "1", state: "cancelled", note: "The person stopped it." }, "router"),
    ).toMatchObject({ ok: true, value: { state: "cancelled" } });
    expect(await run("ticket_assign", { ticket: 1, agentId: "coder" }, "router")).toMatchObject({ ok: false });
    expect(await run("ticket_report", { ticket: 1, state: "done", summary: "x" }, "coder")).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
  });

  it("explains invalid input", async () => {
    expect(await run("ticket_create", { title: "" }, "router")).toMatchObject({
      ok: false,
      error: expect.stringContaining("title"),
    });
  });
});

describe("the worker's report", () => {
  it("lets only the assignee report, and needs humanAction to wait for a person", async () => {
    await run("ticket_create", { title: "Fix login", brief: "y", assignTo: "coder" }, "router");
    expect(await run("ticket_report", { ticket: 1, state: "done", summary: "x" }, "researcher")).toMatchObject({
      ok: false,
    });
    expect(
      await run("ticket_report", { ticket: 1, state: "awaiting_human", summary: "Need a choice." }, "coder"),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("humanAction"),
    });
    expect(
      await run(
        "ticket_report",
        {
          ticket: 1,
          state: "awaiting_human",
          summary: "Two fixes.",
          humanAction: "A: refresh token, B: longer session?",
        },
        "coder",
      ),
    ).toMatchObject({ ok: true, value: { state: "awaiting_human" } });
    expect(await run("ticket_report", { ticket: 1, state: "working", summary: "A chosen." }, "coder")).toMatchObject({
      ok: true,
    });
    expect(await run("ticket_report", { ticket: 1, state: "review", summary: "PR #57." }, "coder")).toMatchObject({
      ok: true,
      value: { state: "review", summary: "PR #57." },
    });
  });
});

describe("lists and reads", () => {
  it("shows a worker only its own tickets, and the Router and Watchdog all", async () => {
    await run("ticket_create", { title: "a", brief: "y", assignTo: "coder" }, "router");
    await run(
      "ticket_create",
      { title: "b", brief: "y" },
      "router",
      ports({ threadKeys: [], sourceKey: "delivery:d2", source: "messaging" }),
    );
    const count = async (caller: string) => {
      const result = await run("ticket_list", {}, caller);
      const value = result.ok ? result.value : null;
      return isDynamicRecord(value) && Array.isArray(value.tickets) ? value.tickets.length : -1;
    };
    expect(await count("router")).toBe(2);
    expect(await count("watch")).toBe(2);
    expect(await count("coder")).toBe(1);
    expect(await run("ticket_read", { ticket: 2 }, "coder")).toMatchObject({ ok: false });
    expect(await run("ticket_read", { ticket: 1 }, "coder")).toMatchObject({ ok: true, value: { brief: "y" } });
  });
});

describe("workerBrief", () => {
  it("carries the brief and tells the worker not to talk with people", () => {
    const { ticket } = store.create({ title: "T", brief: "Do X.", routerAgentId: "router", source: "agent" });
    const text = workerBrief(ticket, "Hurry.");
    expect(text).toContain("Do X.");
    expect(text).toContain("Note from the Router: Hurry.");
    expect(text).toContain("Do not talk with people directly");
  });
});
