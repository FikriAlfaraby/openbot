import { describe, expect, it } from "vitest";
import { messagingPromptText } from "../messaging/messaging-prompt";
import { type BatchCandidate, batchedMessageText, routerBatchCompanions } from "./router-batch";

const message = (id: string, fields: Partial<BatchCandidate> = {}): BatchCandidate => ({
  id,
  status: "queued",
  senderKind: "user",
  authorId: "42",
  resumeTurnId: null,
  planContinuation: false,
  ...fields,
});

describe("routerBatchCompanions", () => {
  it("takes the queued messages of the same author after the head, in order", () => {
    const head = message("a", { status: "queued" });
    expect(routerBatchCompanions(head, [head, message("b"), message("c")])).toEqual(["b", "c"]);
  });

  it("stops at another author, a teammate answer, a started delivery or a usage-limit resume", () => {
    const head = message("a");
    expect(routerBatchCompanions(head, [head, message("b"), message("c", { authorId: "7" }), message("d")])).toEqual([
      "b",
    ]);
    expect(routerBatchCompanions(head, [head, message("b", { senderKind: "agent" }), message("c")])).toEqual([]);
    expect(routerBatchCompanions(head, [head, message("b", { status: "running" })])).toEqual([]);
    expect(routerBatchCompanions(head, [head, message("b", { resumeTurnId: "turn-1" })])).toEqual([]);
    expect(routerBatchCompanions(head, [head, message("b", { planContinuation: true })])).toEqual([]);
  });

  it("leaves earlier messages out and keeps to the limit", () => {
    const head = message("b");
    const conversation = [message("a"), head, ...["c", "d", "e", "f"].map((id) => message(id))];
    expect(routerBatchCompanions(head, conversation)).toEqual(["c", "d", "e", "f"]);
    expect(routerBatchCompanions(head, conversation, 3)).toEqual(["c", "d"]);
  });

  it("batches nothing for a teammate answer, a plan continuation or an unknown author", () => {
    const rest = [message("b")];
    expect(routerBatchCompanions(message("a", { senderKind: "agent" }), [message("a"), ...rest])).toEqual([]);
    expect(routerBatchCompanions(message("a", { planContinuation: true }), [message("a"), ...rest])).toEqual([]);
    expect(routerBatchCompanions(message("a", { authorId: null }), [message("a"), ...rest])).toEqual([]);
    expect(routerBatchCompanions(message("x"), [message("a"), ...rest])).toEqual([]);
  });
});

describe("batchedMessageText", () => {
  it("keeps one message as it is and numbers several", () => {
    expect(batchedMessageText(["halo"])).toBe("halo");
    const text = batchedMessageText(["tolong cek", "", "repo openbot ya"]);
    expect(text).toContain("3 messages from this person, in the order sent");
    expect(text).toContain("(1) tolong cek");
    expect(text).toContain("(2) (The message has no text.)");
    expect(text).toContain("(3) repo openbot ya");
  });

  it("puts every batched message in the message block of the chat prompt", () => {
    const prompt = messagingPromptText({
      platform: "telegram",
      workspaceName: null,
      isDirect: true,
      place: "dm",
      authorName: "Fikri",
      authorId: "42",
      text: batchedMessageText(["first", "second"]),
      context: [],
      replyTo: null,
      skippedFiles: [],
      memories: [],
      guidanceRead: true,
    });
    const block = prompt.slice(prompt.indexOf("--- message ---"));
    expect(block).toContain("(1) first");
    expect(block).toContain("(2) second");
  });
});
