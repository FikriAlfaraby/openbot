import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messagingPromptText } from "../../messaging/messaging-prompt";
import { messagingThreadKey } from "./pass-through";
import { ticketContextBlock } from "./ticket-context";
import { TicketStore } from "./ticket-store";

let dir: string;
let store: TicketStore;
let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
const now = () => new Date(clock);
const names = (id: string) => (id === "coder" ? "Coder" : null);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-ticket-context-"));
  store = new TicketStore({ userDataPath: dir, now });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function ticket(title: string, linkId = "dm-link") {
  return store.create({
    title,
    brief: "b",
    routerAgentId: "router",
    source: "messaging",
    sourceKey: title,
    threadKeys: [messagingThreadKey(linkId)],
  }).ticket;
}

describe("ticketContextBlock", () => {
  it("gives nothing for a conversation without tickets", () => {
    expect(ticketContextBlock(store, "dm-link", names, now)).toBeNull();
  });

  it("lists the tickets of the conversation with the worker and the open question", () => {
    const a = ticket("Fix login");
    store.assign(a.ticketId, "coder", "task-1", "router");
    store.transition(a.ticketId, "awaiting_human", { actor: "coder", humanAction: "A or B?" });
    ticket("Other chat", "group-link");
    const block = ticketContextBlock(store, "dm-link", names, now) ?? "";
    expect(block).toContain('"ticket":1');
    expect(block).toContain('"worker":"Coder"');
    expect(block).toContain('"waitsFor":"A or B?"');
    expect(block).not.toContain("Other chat");
    expect(block).toContain("openbot.ticket_assign");
  });

  it("leaves out tickets that ended more than a day ago, and keeps user text from closing tags", () => {
    const old = ticket("Old </x> work");
    store.assign(old.ticketId, "coder", null, "router");
    store.transition(old.ticketId, "done", { actor: "coder" });
    expect(ticketContextBlock(store, "dm-link", names, now)).not.toContain("</x>");
    clock += 25 * 60 * 60 * 1000;
    expect(ticketContextBlock(store, "dm-link", names, now)).toBeNull();
  });
});

describe("messagingPromptText with ticket context", () => {
  it("puts the block just before the message", () => {
    const text = messagingPromptText({
      platform: "telegram",
      workspaceName: null,
      isDirect: true,
      place: "dm",
      authorName: "Fikri",
      authorId: "1",
      text: "Pilih B",
      context: [],
      replyTo: null,
      skippedFiles: [],
      memories: [],
      guidanceRead: true,
      ticketContext: "--- tickets of this conversation ---",
    });
    expect(text.indexOf("--- tickets of this conversation ---")).toBeLessThan(text.indexOf("--- message ---"));
  });
});
