// Fork module (docs/fork/travel-handover.md). Which messages of a chat go to the copy, and in what
// form. A copy keeps the text, the author, the time and the turn of each message. What points at this
// computer does not go: a file card that points nowhere breaks on the phone, so an attachment becomes
// a line with its name, and delivery, reactions and the turn's trace stay here.

import type { DatabaseSync } from "node:sqlite";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import {
  databaseRows,
  decodeConversationMessageJson,
  requiredNumberColumn,
  requiredStringColumn,
} from "../../database/database-rows";

/** The longest text of one copied message. The handoff reads at most 32,000 characters anyway. */
const HANDOVER_MESSAGE_CHARACTERS = 100_000;
/** The JSON size of one push, under the Team API's 1 MB request limit. */
const HANDOVER_BATCH_BYTES = 700_000;
/** The most messages of one push. */
const HANDOVER_BATCH_MESSAGES = 200;

const PROMPT_ITEM_TYPES = new Set(["question_prompt"]);

/** The message as the copy keeps it, or null for one that is not finished yet. */
function copyableMessage(message: ConversationMessage): ConversationMessage | null {
  if (message.status === "streaming") return null;
  const {
    attachments,
    voiceRecording,
    imageGeneration,
    delivery,
    reaction,
    reactions,
    trace,
    exchange,
    questionPrompt,
    uiBlock,
    ...kept
  } = message;
  const files = [...(attachments ?? []), ...(voiceRecording ? [voiceRecording] : [])].map(
    (attachment) => `[file: ${attachment.name}]`,
  );
  const text = [message.text, ...files].filter((part) => part.length > 0).join("\n");
  const prompt = questionPrompt !== undefined || uiBlock !== undefined || PROMPT_ITEM_TYPES.has(message.itemType ?? "");
  return {
    ...kept,
    text:
      text.length > HANDOVER_MESSAGE_CHARACTERS
        ? `${text.slice(0, HANDOVER_MESSAGE_CHARACTERS)}\n[... the rest stays on the computer ...]`
        : text,
    // A question card cannot be answered on the copy: it is kept as the text it asked.
    ...(prompt ? { itemType: "agentMessage" } : {}),
  };
}

export interface ChatChanges {
  messages: ConversationMessage[];
  /** The highest event sequence read, for the next cursor. */
  lastSequence: number;
  /** Whether rows after these are waiting for the next push. */
  more: boolean;
  /** Rows that could not be read as a message. They are passed over, and the caller reports them. */
  skipped: number;
}

/**
 * The finished messages of `threadId` written after `cursor`, oldest first, cut to one push. A
 * message that is still streaming is left out; when it finishes, its sequence grows past the cursor.
 *
 * One event can write several messages with one sequence. The cursor moves past a sequence only when
 * all of its messages went, so a push that stops inside one sends that sequence again next time; the
 * server writes a message it has already as the same message.
 */
export function readChatChanges(db: DatabaseSync, threadId: string, cursor: number): ChatChanges {
  const rows = databaseRows(
    db
      .prepare(
        `SELECT message_json, last_event_sequence FROM projection_thread_messages
         WHERE thread_id = ? AND last_event_sequence > ?
         ORDER BY last_event_sequence, ordinal LIMIT ?`,
      )
      .all(threadId, cursor, HANDOVER_BATCH_MESSAGES + 1),
  );
  const messages: ConversationMessage[] = [];
  let lastSequence = cursor;
  /** The highest sequence whose messages were all taken. */
  let complete = cursor;
  let bytes = 0;
  let skipped = 0;
  let streaming = false;
  let index = 0;
  for (; index < rows.length && index < HANDOVER_BATCH_MESSAGES; index += 1) {
    const row = rows[index];
    if (!row) break;
    const sequence = requiredNumberColumn(row, "last_event_sequence");
    let message: ConversationMessage;
    try {
      message = decodeConversationMessageJson(requiredStringColumn(row, "message_json"));
    } catch {
      skipped += 1;
      if (sequence !== lastSequence) complete = lastSequence;
      lastSequence = sequence;
      continue;
    }
    const copy = copyableMessage(message);
    if (!copy) {
      streaming = true;
      break;
    }
    const size = Buffer.byteLength(JSON.stringify(copy));
    if (messages.length > 0 && bytes + size > HANDOVER_BATCH_BYTES) break;
    messages.push(copy);
    bytes += size;
    if (sequence !== lastSequence) complete = lastSequence;
    lastSequence = sequence;
  }
  const next = rows[index];
  const stoppedInside = next !== undefined && requiredNumberColumn(next, "last_event_sequence") === lastSequence;
  // A streaming message finishes later, so its sequence is read again. A sequence larger than one
  // push cannot be sent whole: its first part goes, so the chat moves on.
  return {
    messages,
    lastSequence: stoppedInside && (streaming || complete > cursor) ? complete : lastSequence,
    more: index < rows.length,
    skipped,
  };
}

/** The highest event sequence of a chat, or zero for a chat with no message. */
export function lastChatSequence(db: DatabaseSync, threadId: string): number {
  const [row] = databaseRows(
    db
      .prepare(
        "SELECT COALESCE(MAX(last_event_sequence), 0) AS sequence FROM projection_thread_messages WHERE thread_id = ?",
      )
      .all(threadId),
  );
  return row ? requiredNumberColumn(row, "sequence") : 0;
}
