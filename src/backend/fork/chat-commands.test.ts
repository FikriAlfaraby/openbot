import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatCommandOf, ticketStatusReply } from "./chat-commands";
import { parseForkConfig } from "./fork-config";
import { messagingThreadKey } from "./tickets/pass-through";
import { TicketStore } from "./tickets/ticket-store";

let dir: string;
let store: TicketStore;
let clock = Date.UTC(2026, 10, 2, 12);
const now = () => new Date(clock);
const names = (id: string) => (id === "coder" ? "Coder" : null);

function ticket(title: string, link = "link-1") {
  const { ticket: created } = store.create({
    title,
    brief: "b",
    routerAgentId: "router",
    source: "telegram",
    sourceKey: title,
  });
  store.subscribe(created.ticketId, messagingThreadKey(link), "router");
  return created;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openbot-chat-commands-"));
  store = new TicketStore({ userDataPath: dir, now });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chatCommandOf", () => {
  it("knows /tiket, /tickets and /status, also with a bot name", () => {
    for (const text of ["/tiket", "/tickets", "/status", " /TIKET ", "/tiket@OpenBotTim_bot"])
      expect(chatCommandOf(text)).toBe("tickets");
    for (const text of ["tiket", "/tiket baru tolong", "/start", "cek /tiket", "/tiket@bad name"])
      expect(chatCommandOf(text)).toBeNull();
  });
});

describe("ticketStatusReply", () => {
  it("lists live tickets first with state, worker and the open question", () => {
    const fix = ticket("Perbaiki login");
    store.assign(fix.ticketId, "coder", "task-1", "router");
    const ask = ticket("Pilih desain");
    store.assign(ask.ticketId, "designer", "task-2", "router");
    store.transition(ask.ticketId, "awaiting_human", { actor: "designer", humanAction: "A atau B?" });
    const old = ticket("Laporan lama");
    store.assign(old.ticketId, "coder", "task-3", "router");
    store.transition(old.ticketId, "done", { actor: "coder" });
    ticket("Tiket chat lain", "link-2");
    const reply = ticketStatusReply(store, "link-1", names, "id", now);
    expect(reply.split("\n")).toEqual([
      "Tiket di percakapan ini:",
      `#${ask.number} Pilih desain — menunggu jawaban (designer): A atau B?`,
      `#${fix.number} Perbaiki login — dikerjakan (Coder)`,
      `#${old.number} Laporan lama — selesai (Coder)`,
    ]);
  });

  it("leaves out tickets that ended more than a day ago, and says when there are none", () => {
    const old = ticket("Lama");
    store.assign(old.ticketId, "coder", "task-1", "router");
    store.transition(old.ticketId, "done", { actor: "coder" });
    clock += 2 * 86_400_000;
    expect(ticketStatusReply(store, "link-1", names, "id", now)).toBe("Belum ada tiket di percakapan ini.");
    expect(ticketStatusReply(store, "link-1", names, "en", now)).toBe("No tickets in this conversation yet.");
  });

  it("reads chat.commandLanguage", () => {
    const parsed = parseForkConfig("version: 1\nchat:\n  commandLanguage: en\n");
    expect(parsed.ok && parsed.config.commandLanguage).toBe("en");
    expect(parseForkConfig("version: 1\nchat:\n  commandLanguage: fr\n").ok).toBe(false);
  });
});
