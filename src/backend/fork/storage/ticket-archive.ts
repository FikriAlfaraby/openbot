// Fork module (super-agent, roadmap item 4.4). Keeps the fork's own files small on a server.
//
// Once a day the host moves the tickets that ended more than `archiveAfterDays` ago (default 30)
// from `fork-tickets.db` into a monthly JSON Lines file in `<OpenBot>/fork-archive/`, with their
// events, and then deletes them from the database. A ticket is deleted only after its line is
// written. `fork-observations.jsonl` (the gate's observe mode) moves there too when it passes 5 MB.
// The daily backup (`scripts/fork/openbot-backup`) takes the archive folder with the rest, and can
// send it to a bucket. See docs/fork/storage.md.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TicketStore } from "../tickets/ticket-store";

export const FORK_ARCHIVE_DIR = "fork-archive";
export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;
const OBSERVATIONS_FILE_NAME = "fork-observations.jsonl";
const OBSERVATIONS_ROTATE_BYTES = 5_000_000;
const DAY_MS = 24 * 60 * 60_000;

function archiveDir(openbotRoot: string): string {
  const dir = join(openbotRoot, FORK_ARCHIVE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Moves the old ended tickets into the archive. Returns how many moved and the file. */
export function archiveEndedTickets(
  store: TicketStore,
  openbotRoot: string,
  archiveAfterDays: number = DEFAULT_ARCHIVE_AFTER_DAYS,
  now: Date = new Date(),
): { archived: number; file: string | null } {
  const before = new Date(now.getTime() - archiveAfterDays * DAY_MS).toISOString();
  const tickets = store.endedBefore(before);
  if (tickets.length === 0) return { archived: 0, file: null };
  const file = join(archiveDir(openbotRoot), `tickets-${now.toISOString().slice(0, 7)}.jsonl`);
  let archived = 0;
  for (const ticket of tickets) {
    const line = JSON.stringify({
      archivedAt: now.toISOString(),
      ticket,
      events: store.events(ticket.ticketId, 1_000),
      threads: store.threadsOf(ticket.ticketId),
    });
    // The line is on disk before the ticket goes; a failed write leaves the ticket in the database.
    appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    if (store.remove(ticket.ticketId)) archived += 1;
  }
  return { archived, file };
}

/** Moves the observation log into the archive when it passes `maxBytes`. Returns the new path. */
export function rotateObservations(
  openbotRoot: string,
  maxBytes: number = OBSERVATIONS_ROTATE_BYTES,
  now: Date = new Date(),
): string | null {
  const path = join(openbotRoot, OBSERVATIONS_FILE_NAME);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size <= maxBytes) return null;
  const target = join(archiveDir(openbotRoot), `observations-${now.toISOString().replace(/[:.]/gu, "-")}.jsonl`);
  renameSync(path, target);
  return target;
}

/** Whether a day passed since the last run of this process. */
export function archiveDue(lastRun: number | null, now: number): boolean {
  return lastRun === null || now - lastRun >= DAY_MS;
}
