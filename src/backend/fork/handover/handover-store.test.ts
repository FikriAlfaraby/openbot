import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDOVER_DATABASE_FILE_NAME, HandoverError, HandoverStore } from "./handover-store";

let dir: string;
let store: HandoverStore;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-handover-"));
  store = new HandoverStore({ userDataPath: dir, now });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the computer's side", () => {
  it("records a copy, then the cursor of its chat", () => {
    expect(store.recordCopy("cloud", "agent-a", "copy-a")).toMatchObject({
      remoteAgentId: "copy-a",
      registered: false,
      cursor: 0,
      owner: "source",
    });
    store.markRegistered("cloud", "agent-a");
    store.advance("cloud", "agent-a", "thread-a", 42);
    expect(store.outgoing("cloud", "agent-a")).toMatchObject({
      registered: true,
      localThreadId: "thread-a",
      cursor: 42,
    });
    expect(store.listOutgoing("cloud").map((row) => row.localAgentId)).toEqual(["agent-a"]);
    expect(store.listOutgoing("other")).toEqual([]);
  });

  it("locks the agent while a server owns its chat", () => {
    store.recordCopy("cloud", "agent-a", "copy-a");
    expect(store.lockedOutgoing("agent-a")).toBeNull();
    store.setOutgoingOwner("cloud", "agent-a", "copy");
    expect(store.lockedOutgoing("agent-a")).toMatchObject({ serverId: "cloud", remoteAgentId: "copy-a" });
    store.setOutgoingOwner("cloud", "agent-a", "source");
    expect(store.lockedOutgoing("agent-a")).toBeNull();
  });

  it("starts over when the server makes a new copy, and forgets a lost one", () => {
    store.recordCopy("cloud", "agent-a", "copy-a");
    store.advance("cloud", "agent-a", "thread-a", 9);
    store.setOutgoingOwner("cloud", "agent-a", "copy");
    expect(store.recordCopy("cloud", "agent-a", "copy-b")).toMatchObject({
      remoteAgentId: "copy-b",
      cursor: 0,
      owner: "source",
      localThreadId: null,
    });
    store.forgetOutgoing("cloud", "agent-a");
    expect(store.outgoing("cloud", "agent-a")).toBeNull();
  });

  it("refuses a change to an agent with no copy, and a cursor that is not a count", () => {
    expect(() => store.advance("cloud", "nobody", "thread", 1)).toThrow(HandoverError);
    store.recordCopy("cloud", "agent-a", "copy-a");
    expect(() => store.advance("cloud", "agent-a", "thread", -1)).toThrow(HandoverError);
  });
});

describe("the server's side", () => {
  it("registers a copy once and refuses an agent that copies another", () => {
    const first = store.registerIncoming("mac", "agent-a", "copy-a");
    expect(first).toMatchObject({ owner: "source", threadId: null, takeoverSequence: null });
    expect(store.registerIncoming("mac", "agent-a", "copy-a").changedAt).toBe(first.changedAt);
    expect(() => store.registerIncoming("mac", "agent-b", "copy-a")).toThrow(HandoverError);
    // A new copy of the same agent replaces the old one.
    store.registerIncoming("mac", "agent-a", "copy-c");
    expect(store.incomingByAgent("copy-a")).toBeNull();
    expect(store.incomingBySource("mac", "agent-a")?.agentId).toBe("copy-c");
  });

  it("knows the copy's chat", () => {
    store.registerIncoming("mac", "agent-a", "copy-a");
    expect(store.isCopyThread("thread-c")).toBe(false);
    store.setIncomingThread("copy-a", "thread-c");
    expect(store.isCopyThread("thread-c")).toBe(true);
  });

  it("takes the chat over once, and gives it back", () => {
    store.registerIncoming("mac", "agent-a", "copy-a");
    expect(store.takeOver("copy-a", 17)).toBe(true);
    expect(store.takeOver("copy-a", 30)).toBe(false);
    expect(store.incomingByAgent("copy-a")).toMatchObject({ owner: "copy", takeoverSequence: 17 });
    store.release("copy-a");
    expect(store.incomingByAgent("copy-a")).toMatchObject({ owner: "source", takeoverSequence: null });
    expect(store.takeOver("not-a-copy", 1)).toBe(false);
  });
});

it("refuses a file from a newer build", () => {
  store.close();
  const db = new DatabaseSync(join(dir, HANDOVER_DATABASE_FILE_NAME));
  db.exec("PRAGMA user_version = 99");
  db.close();
  expect(() => new HandoverStore({ userDataPath: dir })).toThrow(HandoverError);
  store = new HandoverStore({ userDataPath: mkdtempSync(join(tmpdir(), "openbot-handover-")) });
});
