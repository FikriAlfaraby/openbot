// @vitest-environment node

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BrowserDockPresentation } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeBrowserDockAction,
  decodeBrowserDockPresentation,
  decodeBrowserDockShown,
} from "./browser-dock-decoding";

const AGENT = {
  id: "agent-1",
  name: "Ada",
  title: "Researcher",
  description: "",
  avatarSeed: "agent-1",
  avatarHue: null,
  avatarUrl: null,
};

const PRESENTATION: BrowserDockPresentation = {
  agent: AGENT,
  agents: [AGENT],
  skills: [],
  mcpServers: [{ id: "mcp-1", name: "Files", enabled: true, transport: "stdio", command: "files", args: [], url: "" }],
  draft: { text: "Draft", revision: 2 },
  focusRequest: 0,
  sendShortcut: "meta-enter",
  working: true,
  deliveries: [],
  hold: null,
  editingDeliveryId: null,
  canSteer: true,
  steerSupported: true,
  canRunAsTask: false,
  island: { kind: "activity", control: "agent", label: "Reading the page" },
  handoffPending: false,
  canHandoff: true,
};

const QUESTION = {
  id: "slot",
  header: "Time",
  question: "Which time should I book?",
  isSecret: false,
  options: [{ label: "18:00", description: "Window table." }],
};

const APPROVAL = {
  requestId: 7,
  agentId: "agent-1",
  threadId: "thread-1",
  turnId: "turn-1",
  kind: "command",
  command: "ls",
  cwd: null,
  reason: null,
  grantRoot: null,
  permissions: null,
};

describe("browser dock decoding", () => {
  it("accepts a presentation without MCP secrets, and null to hide the dock", () => {
    expect(decodeBrowserDockPresentation(PRESENTATION)).toEqual(PRESENTATION);
    expect(decodeBrowserDockPresentation(null)).toBeNull();
  });

  it("accepts the question card and the approval card", () => {
    const prompt = {
      ...PRESENTATION,
      island: { kind: "prompt", requestId: "req-1", questions: [QUESTION], attempt: 0 },
    };
    const approval = { ...PRESENTATION, island: { kind: "approval", approval: APPROVAL, attempt: 1 } };
    expect(decodeBrowserDockPresentation(prompt)).toEqual(prompt);
    expect(decodeBrowserDockPresentation(approval)).toEqual(approval);
  });

  it("rejects a question card or an approval card that is not valid", () => {
    const invalid = [
      { kind: "prompt", requestId: "req-1", questions: [], attempt: 0 },
      { kind: "prompt", requestId: "req-1", questions: [{ ...QUESTION, isSecret: "no" }], attempt: 0 },
      { kind: "prompt", requestId: "req-1", questions: [QUESTION] },
      { kind: "approval", approval: { ...APPROVAL, kind: "shell" }, attempt: 0 },
      { kind: "approval", approval: APPROVAL, attempt: -1 },
    ];
    for (const island of invalid) {
      expect(() => decodeBrowserDockPresentation({ ...PRESENTATION, island })).toThrow(
        "Invalid browser dock presentation.",
      );
    }
  });

  it("rejects a presentation that is not valid", () => {
    expect(() => decodeBrowserDockPresentation(undefined)).toThrow("Invalid browser dock presentation.");
    expect(() => decodeBrowserDockPresentation({ ...PRESENTATION, working: "yes" })).toThrow(
      "Invalid browser dock presentation.",
    );
    expect(() => decodeBrowserDockPresentation({ ...PRESENTATION, island: { kind: "unknown" } })).toThrow(
      "Invalid browser dock presentation.",
    );
    expect(() =>
      decodeBrowserDockPresentation({ ...PRESENTATION, draft: { text: "x".repeat(1_000_000), revision: 0 } }),
    ).toThrow("Invalid browser dock presentation.");
  });

  it("accepts the known actions and rejects the others", () => {
    expect(decodeBrowserDockAction({ type: "stop" })).toEqual({ type: "stop" });
    expect(decodeBrowserDockAction({ type: "reorder", deliveryIds: ["a", "b"] })).toEqual({
      type: "reorder",
      deliveryIds: ["a", "b"],
    });
    expect(() => decodeBrowserDockAction({ type: "eval", code: "1" })).toThrow("Invalid browser dock action.");
    expect(() => decodeBrowserDockAction({ type: "send" })).toThrow("Invalid browser dock action.");
    expect(() => decodeBrowserDockAction({ type: "open-link", url: "" })).toThrow("Invalid browser dock action.");
  });

  // Fork: the overlay hands the main renderer the images it imported, and asks it to remove one.
  it("accepts the files of a draft from the overlay within their limits", () => {
    const image = {
      id: "attachment-1",
      name: "screenshot.png",
      size: 1024,
      kind: "image",
      mimeType: "image/png",
      previewKind: "image",
      previewUrl: null,
    };
    expect(decodeBrowserDockAction({ type: "attach", attachments: [image] })).toEqual({
      type: "attach",
      attachments: [image],
    });
    expect(decodeBrowserDockAction({ type: "remove-attachment", attachmentId: "attachment-1" })).toEqual({
      type: "remove-attachment",
      attachmentId: "attachment-1",
    });
    expect(
      decodeBrowserDockPresentation({ ...PRESENTATION, draft: { text: "", revision: 3, attachments: [image] } }),
    ).toMatchObject({ draft: { attachments: [image] } });
    expect(() =>
      decodeBrowserDockAction({
        type: "attach",
        attachments: Array.from({ length: INPUT_LIMITS.draftAttachments + 1 }, () => image),
      }),
    ).toThrow("Invalid browser dock action.");
    expect(() => decodeBrowserDockAction({ type: "attach", attachments: [{ ...image, kind: "script" }] })).toThrow(
      "Invalid browser dock action.",
    );
    expect(() => decodeBrowserDockAction({ type: "remove-attachment" })).toThrow("Invalid browser dock action.");
  });

  it("accepts the answers of a card within their limits", () => {
    const answered = { type: "answer-prompt", requestId: "req-1", answers: { slot: ["18:00"], extra: [] } };
    expect(decodeBrowserDockAction(answered)).toEqual(answered);
    expect(decodeBrowserDockAction({ type: "answer-prompt", requestId: 3, answers: {} })).toEqual({
      type: "answer-prompt",
      requestId: 3,
      answers: {},
    });
    expect(decodeBrowserDockAction({ type: "respond-approval", requestId: 7, decision: "decline" })).toEqual({
      type: "respond-approval",
      requestId: 7,
      decision: "decline",
    });
    const tooLong = "x".repeat(INPUT_LIMITS.promptAnswerText + 1);
    const invalid = [
      { type: "answer-prompt", requestId: "req-1" },
      { type: "answer-prompt", requestId: "", answers: {} },
      { type: "answer-prompt", requestId: "req-1", answers: { slot: "18:00" } },
      { type: "answer-prompt", requestId: "req-1", answers: { slot: [1] } },
      { type: "answer-prompt", requestId: "req-1", answers: { slot: [tooLong] } },
      { type: "respond-approval", requestId: 7, decision: "always" },
    ];
    for (const action of invalid) {
      expect(() => decodeBrowserDockAction(action)).toThrow("Invalid browser dock action.");
    }
  });

  it("accepts only a boolean for the overlay state", () => {
    expect(decodeBrowserDockShown(true)).toBe(true);
    expect(decodeBrowserDockShown(false)).toBe(false);
    expect(() => decodeBrowserDockShown("true")).toThrow("Invalid browser dock state.");
  });
});
