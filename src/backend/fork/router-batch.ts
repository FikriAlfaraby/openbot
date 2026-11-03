// Fork module (super-agent, roadmap item 4.5). Router batching, after the DeepSeek Super-agent
// article (section 2): a person often sends three short chat messages in a row. When they queue
// while the Router works, the Router reads them in one turn and answers once, instead of one turn
// and one answer per message.
//
// Only messages of one conversation (one messaging link) and one author join, in queue order, and
// the run stops at the first message that does not fit, so the queue order stays. The answer goes,
// as for one message, as a reply to the first. Only the agent with the role `router` batches;
// other agents keep upstream's one message per turn in chat platforms.

/** The most messages in one batched turn. */
const ROUTER_BATCH_LIMIT = 10;

export interface BatchCandidate {
  id: string;
  status: string;
  senderKind: string;
  authorId: string | null;
  /** The turn whose usage limit stopped this delivery, if any. */
  resumeTurnId: string | null;
  planContinuation: boolean;
}

/**
 * The queued deliveries that start in the same turn as `head`, from the deliveries of its
 * conversation in queue order.
 */
export function routerBatchCompanions(
  head: BatchCandidate,
  conversation: readonly BatchCandidate[],
  limit = ROUTER_BATCH_LIMIT,
): string[] {
  if (head.senderKind === "agent" || head.planContinuation || head.authorId === null) return [];
  const start = conversation.findIndex((candidate) => candidate.id === head.id);
  if (start < 0) return [];
  const run: string[] = [];
  for (const candidate of conversation.slice(start + 1)) {
    if (
      run.length + 1 >= limit ||
      candidate.status !== "queued" ||
      candidate.senderKind === "agent" ||
      candidate.planContinuation ||
      candidate.authorId !== head.authorId ||
      candidate.resumeTurnId !== head.resumeTurnId
    )
      break;
    run.push(candidate.id);
  }
  return run;
}

/** The text of the person's messages of one turn, for the message block of the chat prompt. */
export function batchedMessageText(texts: readonly string[]): string {
  if (texts.length === 1) return texts[0] ?? "";
  return [
    `${texts.length} messages from this person, in the order sent. Read all of them and answer once.`,
    ...texts.map((text, index) => `(${index + 1}) ${text || "(The message has no text.)"}`),
  ].join("\n\n");
}
