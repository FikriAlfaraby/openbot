import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseForkConfig } from "../fork-config";
import { TicketStore } from "../tickets/ticket-store";
import { archiveDue, archiveEndedTickets, FORK_ARCHIVE_DIR, rotateObservations } from "./ticket-archive";

let dir: string;
let store: TicketStore;
let clock = Date.UTC(2026, 9, 1, 12);
const now = () => new Date(clock);

function ticket(title: string) {
  const { ticket: created } = store.create({
    title,
    brief: "b",
    routerAgentId: "router",
    source: "agent",
    sourceKey: title,
  });
  store.assign(created.ticketId, "coder", `task-${title}`, "router");
  return created;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-archive-"));
  store = new TicketStore({ userDataPath: dir, now });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("archiveEndedTickets", () => {
  it("moves old ended tickets with their events into a monthly file and keeps the rest", () => {
    const old = ticket("old done");
    store.transition(old.ticketId, "done", { actor: "coder" });
    const live = ticket("still working");
    clock += 40 * 86_400_000;
    const recent = ticket("recent done");
    store.transition(recent.ticketId, "cancelled", { actor: "router" });
    const result = archiveEndedTickets(store, dir, 30, now());
    expect(result.archived).toBe(1);
    expect(result.file).toBe(join(dir, FORK_ARCHIVE_DIR, "tickets-2026-11.jsonl"));
    const lines = readFileSync(result.file ?? "", "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.ticket.ticketId).toBe(old.ticketId);
    expect(entry.events.map((event: { kind: string }) => event.kind)).toContain("state");
    expect(statSync(result.file ?? "").mode & 0o777).toBe(0o600);
    expect(store.get(old.ticketId)).toBeNull();
    expect(store.events(old.ticketId)).toEqual([]);
    expect(store.get(live.ticketId)).not.toBeNull();
    expect(store.get(recent.ticketId)).not.toBeNull();
    expect(archiveEndedTickets(store, dir, 30, now())).toEqual({ archived: 0, file: null });
  });

  it("never removes a live ticket", () => {
    const live = ticket("live");
    expect(() => store.remove(live.ticketId)).toThrow(/only an ended ticket/u);
  });
});

describe("rotateObservations", () => {
  it("moves the log only when it passes the size", () => {
    expect(rotateObservations(dir, 10)).toBeNull();
    writeFileSync(join(dir, "fork-observations.jsonl"), "small\n");
    expect(rotateObservations(dir, 10)).toBeNull();
    writeFileSync(join(dir, "fork-observations.jsonl"), "x".repeat(20));
    const moved = rotateObservations(dir, 10, now());
    expect(moved).not.toBeNull();
    expect(existsSync(join(dir, "fork-observations.jsonl"))).toBe(false);
    expect(readdirSync(join(dir, FORK_ARCHIVE_DIR))).toHaveLength(1);
  });
});

describe("archive schedule and setting", () => {
  it("runs once a day", () => {
    expect(archiveDue(null, 0)).toBe(true);
    expect(archiveDue(0, 86_399_999)).toBe(false);
    expect(archiveDue(0, 86_400_000)).toBe(true);
  });

  it("reads storage.archiveAfterDays", () => {
    const parsed = parseForkConfig("version: 1\nstorage:\n  archiveAfterDays: 90\n");
    expect(parsed.ok && parsed.config.archiveAfterDays).toBe(90);
    expect(parseForkConfig("version: 1\nstorage:\n  archiveAfterDays: 0\n").ok).toBe(false);
  });
});
