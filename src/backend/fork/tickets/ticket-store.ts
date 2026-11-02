// Fork module (super-agent, roadmap item 2.4). Tickets: one unit of authorized work each, after the
// DeepSeek Super-agent prototype (`docs/001-domain.md`). The Router creates a ticket for each piece
// of work, assigns it to a worker, and follows its state. Every change is an event in an
// append-only log.
//
// The tickets live in `fork-tickets.db`, a SQLite file of their own beside `openbot.db`, not in a
// migration of `openbot.db`: upstream owns that migration sequence, and a fork migration would
// collide with upstream's next version at the next sync (docs/fork/ROADMAP.md, default decisions).
// The file has its own small schema version in `PRAGMA user_version`.
//
// Synchronous, like the other stores: SQLite calls are short, and callers run them in a step.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  checkedColumn,
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../../database/database-rows";

export const TICKET_DATABASE_FILE_NAME = "fork-tickets.db";

export const TICKET_STATES = [
  "open",
  "working",
  "awaiting_human",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/** A ticket that no worker works on now. A person's message can resume `done` and `failed`; `cancelled` is final. */
export const ENDED_TICKET_STATES: ReadonlySet<TicketState> = new Set(["done", "failed", "cancelled"]);

/** The states each state can move to. `cancelled` means a person stopped the work, so it is final. */
const TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  open: ["working", "cancelled", "failed"],
  working: ["awaiting_human", "review", "blocked", "done", "failed", "cancelled"],
  awaiting_human: ["working", "cancelled", "failed"],
  review: ["working", "done", "cancelled"],
  blocked: ["working", "cancelled", "failed"],
  done: ["working"],
  failed: ["working", "cancelled"],
  cancelled: [],
};

export const TICKET_SOURCES = ["messaging", "telegram", "app", "routine", "agent", "other"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const TICKET_LIMITS = {
  title: 200,
  brief: 8_000,
  note: 2_000,
  summary: 4_000,
  humanAction: 1_000,
  key: 512,
  list: 200,
} as const;

export interface Ticket {
  ticketId: string;
  /** A short number for people: "ticket #12". */
  number: number;
  title: string;
  brief: string;
  state: TicketState;
  routerAgentId: string;
  assigneeAgentId: string | null;
  source: TicketSource;
  /** The message that created the ticket, so that a retry finds it instead of making a second one. */
  sourceKey: string | null;
  /** The worker's side thread (task) that runs the ticket. */
  taskId: string | null;
  /** The T3 Code thread of a coding ticket (item 3.1). */
  t3ThreadId: string | null;
  /** The last summary from the worker. */
  summary: string | null;
  /** What a person must decide, when the state is `awaiting_human`. */
  humanAction: string | null;
  /** The JSON of the ticket's mandate (item 3.4). */
  mandateJson: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

const stores = new Map<string, TicketStore>();

/** One store per user data folder for the process, opened at first use. */
export function ticketStoreFor(userDataPath: string): TicketStore {
  let store = stores.get(userDataPath);
  if (!store) {
    store = new TicketStore({ userDataPath });
    stores.set(userDataPath, store);
  }
  return store;
}

export interface TicketEvent {
  seq: number;
  ticketId: string;
  at: string;
  kind: "created" | "assigned" | "state" | "note" | "t3" | "subscribed" | "unsubscribed";
  actor: string;
  fromState: TicketState | null;
  toState: TicketState | null;
  note: string | null;
}

export class TicketError extends Error {
  constructor(
    readonly code: "not-found" | "transition" | "too-long" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tickets (
    ticket_id TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE CHECK (number >= 1),
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${TICKET_STATES.map((state) => `'${state}'`).join(", ")})),
    router_agent_id TEXT NOT NULL,
    assignee_agent_id TEXT,
    source TEXT NOT NULL CHECK (source IN (${TICKET_SOURCES.map((source) => `'${source}'`).join(", ")})),
    source_key TEXT UNIQUE,
    task_id TEXT,
    t3_thread_id TEXT,
    summary TEXT,
    human_action TEXT,
    mandate_json TEXT CHECK (mandate_json IS NULL OR json_valid(mandate_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS tickets_state ON tickets (state, updated_at);
  CREATE INDEX IF NOT EXISTS tickets_assignee ON tickets (assignee_agent_id, state);
  CREATE INDEX IF NOT EXISTS tickets_task ON tickets (task_id) WHERE task_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS ticket_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets (ticket_id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events (ticket_id, seq);
  CREATE TABLE IF NOT EXISTS ticket_subscriptions (
    ticket_id TEXT NOT NULL REFERENCES tickets (ticket_id) ON DELETE CASCADE,
    thread_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (ticket_id, thread_key)
  );
  CREATE INDEX IF NOT EXISTS ticket_subscriptions_thread ON ticket_subscriptions (thread_key);
`;

function ticketOf(row: DynamicRecord): Ticket {
  return {
    ticketId: requiredStringColumn(row, "ticket_id"),
    number: requiredNumberColumn(row, "number"),
    title: requiredStringColumn(row, "title"),
    brief: requiredStringColumn(row, "brief"),
    state: checkedColumn(row, "state", TICKET_STATES),
    routerAgentId: requiredStringColumn(row, "router_agent_id"),
    assigneeAgentId: optionalStringColumn(row, "assignee_agent_id"),
    source: checkedColumn(row, "source", TICKET_SOURCES),
    sourceKey: optionalStringColumn(row, "source_key"),
    taskId: optionalStringColumn(row, "task_id"),
    t3ThreadId: optionalStringColumn(row, "t3_thread_id"),
    summary: optionalStringColumn(row, "summary"),
    humanAction: optionalStringColumn(row, "human_action"),
    mandateJson: optionalStringColumn(row, "mandate_json"),
    createdAt: requiredStringColumn(row, "created_at"),
    updatedAt: requiredStringColumn(row, "updated_at"),
    endedAt: optionalStringColumn(row, "ended_at"),
  };
}

const EVENT_KINDS = ["created", "assigned", "state", "note", "t3", "subscribed", "unsubscribed"] as const;

function optionalState(row: DynamicRecord, key: string): TicketState | null {
  return row[key] === null || row[key] === undefined ? null : checkedColumn(row, key, TICKET_STATES);
}

function eventOf(row: DynamicRecord): TicketEvent {
  return {
    seq: requiredNumberColumn(row, "seq"),
    ticketId: requiredStringColumn(row, "ticket_id"),
    at: requiredStringColumn(row, "at"),
    kind: checkedColumn(row, "kind", EVENT_KINDS),
    actor: requiredStringColumn(row, "actor"),
    fromState: optionalState(row, "from_state"),
    toState: optionalState(row, "to_state"),
    note: optionalStringColumn(row, "note"),
  };
}

/** One row, or null. */
function oneTicket(value: unknown): Ticket | null {
  const row = databaseRow(value);
  return row ? ticketOf(row) : null;
}

function limited(value: string, max: number, field: string): string {
  const text = value.trim();
  if (Array.from(text).length > max) throw new TicketError("too-long", `${field} is longer than ${max} characters.`);
  return text;
}

export interface CreateTicketInput {
  title: string;
  brief: string;
  routerAgentId: string;
  source: TicketSource;
  sourceKey?: string | null;
  /** Threads to subscribe the ticket to at once, such as the Telegram thread of the request. */
  threadKeys?: readonly string[];
  actor?: string;
}

export interface TransitionInput {
  actor: string;
  note?: string | null;
  summary?: string | null;
  humanAction?: string | null;
}

export interface TicketStoreOptions {
  /** The folder of `openbot.db`; the ticket file goes beside it. */
  userDataPath: string;
  now?: () => Date;
}

/**
 * Owns `fork-tickets.db`: tickets, their event log, and their thread subscriptions. It never imports
 * the `openbot.db` facade.
 */
export class TicketStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(options: TicketStoreOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#db = new DatabaseSync(join(options.userDataPath, TICKET_DATABASE_FILE_NAME));
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #migrate(): void {
    const row = databaseRow(this.#db.prepare("PRAGMA user_version").get());
    const version = row ? requiredNumberColumn(row, "user_version") : 0;
    if (version > SCHEMA_VERSION)
      throw new TicketError("invalid", `${TICKET_DATABASE_FILE_NAME} has schema ${version}, newer than this build.`);
    if (version === SCHEMA_VERSION) return;
    this.#transaction(() => {
      this.#db.exec(SCHEMA_SQL);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  #transaction<A>(run: () => A): A {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #event(ticketId: string, kind: TicketEvent["kind"], actor: string, extra: Partial<TicketEvent> = {}): void {
    this.#db
      .prepare(
        "INSERT INTO ticket_events (ticket_id, at, kind, actor, from_state, to_state, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ticketId, this.#stamp(), kind, actor, extra.fromState ?? null, extra.toState ?? null, extra.note ?? null);
  }

  #require(ticketId: string): Ticket {
    const ticket = this.get(ticketId);
    if (!ticket) throw new TicketError("not-found", `There is no ticket ${ticketId}.`);
    return ticket;
  }

  /** Creates a ticket in `open`, or returns the ticket that the same source key made before. */
  create(input: CreateTicketInput): { ticket: Ticket; created: boolean } {
    const title = limited(input.title, TICKET_LIMITS.title, "title");
    const brief = limited(input.brief, TICKET_LIMITS.brief, "brief");
    if (!title) throw new TicketError("invalid", "A ticket needs a title.");
    const sourceKey = input.sourceKey ? limited(input.sourceKey, TICKET_LIMITS.key, "sourceKey") : null;
    return this.#transaction(() => {
      if (sourceKey) {
        const existing = oneTicket(this.#db.prepare("SELECT * FROM tickets WHERE source_key = ?").get(sourceKey));
        if (existing) return { ticket: existing, created: false };
      }
      const nextRow = databaseRow(this.#db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tickets").get());
      const next = { next: nextRow ? requiredNumberColumn(nextRow, "next") : 1 };
      const ticketId = `tkt_${randomUUID().replaceAll("-", "")}`;
      const at = this.#stamp();
      this.#db
        .prepare(
          `INSERT INTO tickets (ticket_id, number, title, brief, state, router_agent_id, source, source_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(ticketId, next.next, title, brief, input.routerAgentId, input.source, sourceKey, at, at);
      this.#event(ticketId, "created", input.actor ?? input.routerAgentId, { toState: "open" });
      for (const threadKey of input.threadKeys ?? [])
        this.#subscribe(ticketId, threadKey, input.actor ?? input.routerAgentId);
      return { ticket: this.#require(ticketId), created: true };
    });
  }

  get(ticketId: string): Ticket | null {
    return oneTicket(this.#db.prepare("SELECT * FROM tickets WHERE ticket_id = ?").get(ticketId));
  }

  byNumber(number: number): Ticket | null {
    return oneTicket(this.#db.prepare("SELECT * FROM tickets WHERE number = ?").get(number));
  }

  byTask(taskId: string): Ticket | null {
    return oneTicket(
      this.#db.prepare("SELECT * FROM tickets WHERE task_id = ? ORDER BY number DESC LIMIT 1").get(taskId),
    );
  }

  /** Newest first. */
  list(filter: { states?: readonly TicketState[]; assigneeAgentId?: string; limit?: number } = {}): Ticket[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      values.push(...filter.states);
    }
    if (filter.assigneeAgentId) {
      where.push("assignee_agent_id = ?");
      values.push(filter.assigneeAgentId);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 50, TICKET_LIMITS.list));
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY number DESC LIMIT ${limit}`,
        )
        .all(...values),
    ).map(ticketOf);
  }

  /** Ended tickets that did not change since `before` (an ISO time), oldest first (item 4.4). */
  endedBefore(before: string, limit = 200): Ticket[] {
    const states = [...ENDED_TICKET_STATES];
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM tickets WHERE state IN (${states.map(() => "?").join(", ")}) AND updated_at < ? ORDER BY updated_at LIMIT ?`,
        )
        .all(...states, before, Math.max(1, Math.min(limit, 1_000))),
    ).map(ticketOf);
  }

  /** Deletes an ended ticket with its events and subscriptions, after it was archived (item 4.4). */
  remove(ticketId: string): boolean {
    const ticket = this.get(ticketId);
    if (!ticket) return false;
    if (!ENDED_TICKET_STATES.has(ticket.state))
      throw new TicketError(
        "transition",
        `Ticket #${ticket.number} is ${ticket.state}; only an ended ticket is removed.`,
      );
    return this.#db.prepare("DELETE FROM tickets WHERE ticket_id = ?").run(ticketId).changes > 0;
  }

  /** Gives the ticket to a worker and its side thread, and moves it to `working`. */
  assign(ticketId: string, assigneeAgentId: string, taskId: string | null, actor: string): Ticket {
    return this.#transaction(() => {
      const ticket = this.#require(ticketId);
      if (ticket.state !== "working" && !TRANSITIONS[ticket.state].includes("working"))
        throw new TicketError("transition", `Ticket #${ticket.number} is ${ticket.state} and cannot be assigned.`);
      const at = this.#stamp();
      this.#db
        .prepare(
          "UPDATE tickets SET assignee_agent_id = ?, task_id = ?, state = 'working', human_action = NULL, ended_at = NULL, updated_at = ? WHERE ticket_id = ?",
        )
        .run(assigneeAgentId, taskId, at, ticketId);
      this.#event(ticketId, "assigned", actor, { fromState: ticket.state, toState: "working", note: assigneeAgentId });
      return this.#require(ticketId);
    });
  }

  /** Moves the ticket to another state, with the worker's summary and what a person must decide. */
  transition(ticketId: string, to: TicketState, input: TransitionInput): Ticket {
    const note = input.note ? limited(input.note, TICKET_LIMITS.note, "note") : null;
    const summary = input.summary ? limited(input.summary, TICKET_LIMITS.summary, "summary") : null;
    const humanAction = input.humanAction ? limited(input.humanAction, TICKET_LIMITS.humanAction, "humanAction") : null;
    if (to === "awaiting_human" && !humanAction)
      throw new TicketError(
        "invalid",
        "A ticket that waits for a person needs humanAction: what the person must decide.",
      );
    return this.#transaction(() => {
      const ticket = this.#require(ticketId);
      if (ticket.state === to && to !== "working") {
        // The same state again keeps the newest summary, so a retry of a report does not fail.
        if (summary || humanAction)
          this.#update(ticketId, to, summary ?? ticket.summary, humanAction ?? ticket.humanAction);
        return this.#require(ticketId);
      }
      if (ticket.state !== to && !TRANSITIONS[ticket.state].includes(to))
        throw new TicketError("transition", `Ticket #${ticket.number} cannot move from ${ticket.state} to ${to}.`);
      this.#update(ticketId, to, summary ?? ticket.summary, to === "awaiting_human" ? humanAction : null);
      this.#event(ticketId, "state", input.actor, { fromState: ticket.state, toState: to, note });
      return this.#require(ticketId);
    });
  }

  #update(ticketId: string, state: TicketState, summary: string | null, humanAction: string | null): void {
    const at = this.#stamp();
    this.#db
      .prepare(
        "UPDATE tickets SET state = ?, summary = ?, human_action = ?, updated_at = ?, ended_at = ? WHERE ticket_id = ?",
      )
      .run(state, summary, humanAction, at, ENDED_TICKET_STATES.has(state) ? at : null, ticketId);
  }

  /** Records the T3 Code thread of a coding ticket. */
  setT3Thread(ticketId: string, t3ThreadId: string, actor: string): Ticket {
    const id = limited(t3ThreadId, TICKET_LIMITS.key, "t3ThreadId");
    return this.#transaction(() => {
      this.#require(ticketId);
      this.#db
        .prepare("UPDATE tickets SET t3_thread_id = ?, updated_at = ? WHERE ticket_id = ?")
        .run(id, this.#stamp(), ticketId);
      this.#event(ticketId, "t3", actor, { note: id });
      return this.#require(ticketId);
    });
  }

  setMandate(ticketId: string, mandate: unknown, actor: string): Ticket {
    const json = JSON.stringify(mandate);
    return this.#transaction(() => {
      const ticket = this.#require(ticketId);
      if (ticket.mandateJson !== null)
        throw new TicketError(
          "invalid",
          `Ticket #${ticket.number} has a mandate already; a wider scope needs a new ticket.`,
        );
      this.#db
        .prepare("UPDATE tickets SET mandate_json = ?, updated_at = ? WHERE ticket_id = ?")
        .run(json, this.#stamp(), ticketId);
      this.#event(ticketId, "note", actor, { note: "mandate recorded" });
      return this.#require(ticketId);
    });
  }

  /** A free note in the log, such as a Watchdog observation. */
  note(ticketId: string, actor: string, note: string): void {
    const text = limited(note, TICKET_LIMITS.note, "note");
    this.#transaction(() => {
      this.#require(ticketId);
      this.#event(ticketId, "note", actor, { note: text });
    });
  }

  events(ticketId: string, limit = 100): TicketEvent[] {
    return databaseRows(
      this.#db
        .prepare(
          `SELECT seq, ticket_id, at, kind, actor, from_state, to_state, note FROM ticket_events WHERE ticket_id = ? ORDER BY seq DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
        )
        .all(ticketId),
    )
      .map(eventOf)
      .reverse();
  }

  #subscribe(ticketId: string, threadKey: string, actor: string): boolean {
    const key = limited(threadKey, TICKET_LIMITS.key, "threadKey");
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO ticket_subscriptions (ticket_id, thread_key, created_at) VALUES (?, ?, ?)")
      .run(ticketId, key, this.#stamp());
    if (result.changes > 0) this.#event(ticketId, "subscribed", actor, { note: key });
    return result.changes > 0;
  }

  /** Subscribes a ticket to a thread: follow-ups in it reach the ticket (item 2.6). */
  subscribe(ticketId: string, threadKey: string, actor: string): boolean {
    return this.#transaction(() => {
      this.#require(ticketId);
      return this.#subscribe(ticketId, threadKey, actor);
    });
  }

  unsubscribe(ticketId: string, threadKey: string, actor: string): boolean {
    return this.#transaction(() => {
      const result = this.#db
        .prepare("DELETE FROM ticket_subscriptions WHERE ticket_id = ? AND thread_key = ?")
        .run(ticketId, threadKey);
      if (result.changes > 0) this.#event(ticketId, "unsubscribed", actor, { note: threadKey });
      return result.changes > 0;
    });
  }

  /** The tickets subscribed to a thread that are not cancelled, newest first. */
  subscribers(threadKey: string): Ticket[] {
    return databaseRows(
      this.#db
        .prepare(
          `SELECT t.* FROM tickets t JOIN ticket_subscriptions s ON s.ticket_id = t.ticket_id
           WHERE s.thread_key = ? AND t.state <> 'cancelled' ORDER BY t.number DESC`,
        )
        .all(threadKey),
    ).map(ticketOf);
  }

  threadsOf(ticketId: string): string[] {
    return databaseRows(
      this.#db
        .prepare("SELECT thread_key FROM ticket_subscriptions WHERE ticket_id = ? ORDER BY created_at")
        .all(ticketId),
    ).map((row) => requiredStringColumn(row, "thread_key"));
  }
}
