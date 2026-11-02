import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { originDeliveryId, recordStoppedTurn } from "./stop-recovery";
import { TicketStore } from "./ticket-store";

let dir: string;
let store: TicketStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-stop-recovery-"));
  store = new TicketStore({ userDataPath: dir });
  const { ticket } = store.create({
    title: "Fix login",
    brief: "b",
    routerAgentId: "router",
    source: "messaging",
    sourceKey: "delivery:d-7:Fix login",
  });
  store.assign(ticket.ticketId, "coder", "task-1", "router");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recordStoppedTurn", () => {
  it("blocks a working ticket whose worker turn failed, and tells the Router how to go on", () => {
    const stopped = recordStoppedTurn(store, "task-1", "failed", "turn-9");
    expect(stopped?.ticket.state).toBe("blocked");
    expect(stopped?.idempotencyKey).toBe(`ticket-stop:${stopped?.ticket.ticketId}:turn-9`);
    expect(stopped?.originDeliveryId).toBe("d-7");
    expect(stopped?.text).toContain("Ticket #1 (Fix login) stopped: the worker's turn failed");
    expect(stopped?.text).toContain("openbot.ticket_assign (ticket 1, agentId coder");
    expect(stopped?.text).toContain("openbot.ticket_close");
  });

  it("does nothing for a completed turn, an unknown task, or a ticket that is not working", () => {
    expect(recordStoppedTurn(store, "task-1", "completed", "t")).toBeNull();
    expect(recordStoppedTurn(store, "task-unknown", "failed", "t")).toBeNull();
    recordStoppedTurn(store, "task-1", "interrupted", "t1");
    // Already blocked: a second end event of the same stop adds nothing.
    expect(recordStoppedTurn(store, "task-1", "interrupted", "t1")).toBeNull();
  });

  it("lets the Router resume the blocked ticket", () => {
    const stopped = recordStoppedTurn(store, "task-1", "interrupted", "t1");
    expect(stopped?.text).toContain("was interrupted");
    const resumed = store.assign(stopped?.ticket.ticketId ?? "", "coder", "task-2", "router");
    expect(resumed.state).toBe("working");
  });
});

describe("originDeliveryId", () => {
  it("reads the delivery id that ticket_create wrote", () => {
    expect(originDeliveryId("delivery:abc-1:Fix: login")).toBe("abc-1");
    expect(originDeliveryId(null)).toBeNull();
    expect(originDeliveryId("other")).toBeNull();
  });
});
