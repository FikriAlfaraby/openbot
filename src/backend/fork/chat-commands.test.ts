import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatCommandOf, helpReply, ticketDetailReply, ticketStatusReply } from "./chat-commands";
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
      expect(chatCommandOf(text)).toEqual({ kind: "tickets" });
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

describe("/tiket <number> (item 5.7)", () => {
  it("reads a ticket number, with or without #", () => {
    expect(chatCommandOf("/tiket 12")).toEqual({ kind: "ticket", number: 12 });
    expect(chatCommandOf("/tiket@OpenBotTim_bot #7")).toEqual({ kind: "ticket", number: 7 });
    expect(chatCommandOf("/tiket 12 tolong")).toBeNull();
  });

  it("shows one ticket of this conversation with its question, summary and steps", () => {
    const ask = ticket("Pilih desain");
    store.assign(ask.ticketId, "coder", "task-1", "router");
    store.note(ask.ticketId, "watch", "internal note");
    store.transition(ask.ticketId, "awaiting_human", {
      actor: "coder",
      humanAction: "A atau B?",
      summary: "Dua desain siap: A biru, B hijau.",
    });
    const reply = ticketDetailReply(store, "link-1", ask.number, names, "id");
    const at = `${now().toISOString().slice(0, 10)} ${now().toISOString().slice(11, 16)} UTC`;
    expect(reply.split("\n")).toEqual([
      `#${ask.number} Pilih desain — menunggu jawaban (Coder)`,
      "Menunggu jawaban: A atau B?",
      "Ringkasan: Dua desain siap: A biru, B hijau.",
      "Langkah terakhir:",
      `- ${at} dibuat`,
      `- ${at} diberikan ke Coder`,
      `- ${at} menunggu jawaban`,
    ]);
    expect(reply).not.toContain("internal note");
  });

  it("does not show a ticket of another conversation", () => {
    const other = ticket("Rahasia", "link-2");
    expect(ticketDetailReply(store, "link-1", other.number, names, "id")).toBe(
      `Tiket #${other.number} tidak ada di percakapan ini.`,
    );
    expect(ticketDetailReply(store, "link-1", 999, names, "en")).toBe("Ticket #999 is not in this conversation.");
  });
});

describe("/bantuan (item 5.8)", () => {
  it("is the help command in both languages, also with a bot name", () => {
    for (const text of ["/bantuan", "/help", "/HELP@OpenBotTim_bot"])
      expect(chatCommandOf(text)).toEqual({ kind: "help" });
    expect(chatCommandOf("/bantuan dong")).toBeNull();
  });

  it("lists the commands that the host answers", () => {
    for (const language of ["id", "en"] as const) {
      const text = helpReply(language);
      expect(text).toContain("/tiket");
      expect(text).toContain("/tiket 12");
      expect(text).toContain("stop");
    }
    expect(helpReply()).toContain("Cara memakai bot ini");
  });
});
