// Travel handover across its boundaries: two real `openbot.db` files (the computer and the server),
// the real wire codecs between them, the server's handover rules and the computer's sync. Only the
// transport is a function call, and the conversation runtime is the database write it wraps.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { optionalRouteCodec } from "@openbot/contracts/team-protocol/optional-routes";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHandoffHistory, renderProviderHandoff } from "../../../backend/agent/handoff-history";
import { runCauseEffect } from "../../../backend/effect-boundary";
import type { HandoverChat } from "../../../backend/fork/handover/handover-conversation";
import { handoverBeforeUserMessage } from "../../../backend/fork/handover/handover-guard";
import { HandoverStore } from "../../../backend/fork/handover/handover-store";
import { OpenBotDatabase } from "../../../backend/openbot-database";
import { RemoteRequestError } from "../../remote-server-errors";
import { HttpError } from "../../team-api/http-error";
import { HandoverServer } from "./handover-server";
import { type HandoverCallBody, HandoverSync } from "./handover-sync";

interface Side {
  database: OpenBotDatabase;
  store: HandoverStore;
  chat: HandoverChat & { ended: string[]; busyAgents: Set<string> };
}

const roots: string[] = [];
let mac: Side;
let cloud: Side;
let routines: { id: string; active: boolean }[];
let sync: HandoverSync;

function agent(id: string, threadId: string): AgentSummary {
  return {
    id,
    provider: "claude",
    name: "Chief",
    title: "Coordinator",
    description: "",
    notifications: true,
    model: "claude-opus-5-5",
    reasoningEffort: "medium",
    threadId,
    workspacePath: `/tmp/${id}`,
    preview: "",
    updatedAt: "2026-11-04T10:00:00.000Z",
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

async function side(agents: AgentSummary[]): Promise<Side> {
  const root = await mkdtemp(join(tmpdir(), "openbot-handover-flow-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents(`seed-${root}`, agents, "agents.imported");
  const ended: string[] = [];
  const busyAgents = new Set<string>();
  const find = (agentId: string) => agents.find((candidate) => candidate.id === agentId) ?? null;
  const chat: Side["chat"] = {
    ended,
    busyAgents,
    get userDataPath() {
      return root;
    },
    get connection() {
      return database.connection;
    },
    agent: find,
    agents: () => agents,
    writeMainChat: (agentId, messages) => {
      const threadId = find(agentId)?.threadId;
      if (!threadId) throw new Error(`No chat for ${agentId}.`);
      database.persistConversationChanges({
        agentId,
        threadId,
        activeTurnId: null,
        changedMessages: messages,
        eventType: "fork.handover-copied",
      });
      return threadId;
    },
    busy: (agentId) => busyAgents.has(agentId),
    endContext: async (agentId) => {
      ended.push(agentId);
    },
  };
  return { database, store: new HandoverStore({ userDataPath: root }), chat };
}

function message(id: string, author: "user" | "assistant", text: string, extra: Partial<ConversationMessage> = {}) {
  return {
    id,
    author,
    text,
    createdAt: `2026-11-04T10:00:0${id.length % 10}.000Z`,
    status: "completed",
    ...extra,
  } satisfies ConversationMessage;
}

/** The messages of a chat as its database keeps them, oldest first. */
function texts(database: OpenBotDatabase, agentId: string, threadId: string): string[] {
  return database.readConversation(agentId, threadId).messages.map((entry) => `${entry.author}: ${entry.text}`);
}

/** One server call over the real wire codec, the way the Team API carries it. */
async function call(server: HandoverServer, path: string, body: HandoverCallBody): Promise<TeamProtocolV2Json> {
  const codec = optionalRouteCodec(path);
  if (!codec) throw new RemoteRequestError(404, "Not found.");
  const input = codec.request(JSON.parse(JSON.stringify(body)));
  if (!isDynamicRecord(input)) throw new Error("Invalid request.");
  const read = (field: string) => input[field];
  const source = { sourceServerId: String(read("sourceServerId")), sourceAgentId: String(read("sourceAgentId")) };
  try {
    const result = path.endsWith("/register")
      ? server.register({ ...source, agentId: String(read("agentId")) })
      : path.endsWith("/push")
        ? server.push({ ...source, messages: body.messages ?? [] })
        : path.endsWith("/status")
          ? server.status({ sourceServerId: source.sourceServerId, agentIds: body.agentIds ?? [] })
          : path.endsWith("/pull")
            ? server.pull({ ...source, after: body.after ?? 0 })
            : await server.release(source);
    return codec.response(200, JSON.parse(JSON.stringify(result)));
  } catch (error) {
    if (error instanceof HttpError) throw new RemoteRequestError(error.status, error.message);
    throw error;
  }
}

beforeEach(async () => {
  mac = await side([agent("chief", "thread-chief")]);
  cloud = await side([agent("copy-chief", "thread-copy")]);
  routines = [{ id: "daily", active: true }];
  const server = new HandoverServer({
    conversation: cloud.chat,
    store: cloud.store,
    routines: {
      listRoutines: () => routines,
      updateRoutine: (input) => {
        routines = routines.map((routine) =>
          routine.id === input.routineId ? { ...routine, active: input.active } : routine,
        );
      },
    },
  });
  sync = new HandoverSync({
    conversation: mac.chat,
    store: mac.store,
    localServerId: () => "mac-server",
    settings: () => ({ server: "fikri-cloud", agents: null, everyMinutes: null }),
    remote: {
      servers: () => [{ id: "cloud", name: "fikri-cloud", kind: "remote", state: "online" }],
      call: (_serverId, path, body) => call(server, path, body),
      copyAgent: async () => "copy-chief",
    },
  });
});

afterEach(async () => {
  sync.stop();
  for (const one of [mac, cloud]) {
    one.store.close();
    one.database.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("travel handover", () => {
  it("copies the chat, hands it over on a reply in the copy, and brings it back", async () => {
    // The turn is still running: its streaming answer waits.
    mac.database.persistConversationChanges({
      agentId: "chief",
      threadId: "thread-chief",
      activeTurnId: "turn-1",
      eventType: "fork.handover-copied",
      changedMessages: [
        message("m1", "user", "Plan the release"),
        message("m2", "assistant", "Here is the plan", {
          attachments: [
            {
              id: "f1",
              name: "plan.md",
              size: 5,
              kind: "file",
              mimeType: "text/markdown",
              previewKind: "text",
              previewUrl: null,
            },
          ],
        }),
        message("m3", "assistant", "Still writing", { status: "streaming", turnId: "turn-1" }),
      ],
    });

    await sync.round();

    // The copy has the finished messages, a file as its name, and no routine of its own.
    expect(texts(cloud.database, "copy-chief", "thread-copy")).toEqual([
      "user: Plan the release",
      "assistant: Here is the plan\n[file: plan.md]",
    ]);
    expect(routines).toEqual([{ id: "daily", active: false }]);
    expect(cloud.store.isCopyThread("thread-copy")).toBe(true);

    // On the phone, the owner replies in the copy: the server owns the chat from now on.
    handoverBeforeUserMessage(
      cloud.store,
      cloud.database.connection,
      cloud.chat.agent("copy-chief") ?? agent("", ""),
      null,
    );
    cloud.chat.writeMainChat("copy-chief", [
      message("c1", "user", "Ship it from the train"),
      message("c2", "assistant", "Shipped"),
    ]);

    // The computer finishes its streamed answer; the next round sees the takeover and sends nothing.
    mac.chat.writeMainChat("chief", [message("m3", "assistant", "Done writing")]);
    await sync.round();
    expect(sync.states()).toEqual([{ agentId: "chief", serverId: "cloud", serverName: "fikri-cloud", owner: "copy" }]);
    expect(texts(cloud.database, "copy-chief", "thread-copy")).not.toContain("assistant: Done writing");
    expect(() =>
      handoverBeforeUserMessage(mac.store, mac.database.connection, agent("chief", "thread-chief"), null),
    ).toThrow(sourceText("error.agent.handoverLocked", { server: "fikri-cloud" }));

    // Bring back: the server's messages come here, both sides start fresh sessions, the lock goes.
    await sync.bringBack("chief");
    expect(texts(mac.database, "chief", "thread-chief")).toEqual(
      expect.arrayContaining(["user: Ship it from the train", "assistant: Shipped"]),
    );
    expect(mac.chat.ended).toEqual(["chief"]);
    expect(cloud.chat.ended).toEqual(["copy-chief"]);
    expect(sync.states()[0]?.owner).toBe("source");
    expect(cloud.store.incomingByAgent("copy-chief")?.owner).toBe("source");

    // The copy follows the computer again.
    await sync.round();
    expect(texts(cloud.database, "copy-chief", "thread-copy")).toContain("assistant: Done writing");
  });

  it("copies a message that an ended turn left streaming, and the messages after it", async () => {
    // The turn ended with its plan still marked streaming; it will never finish.
    mac.chat.writeMainChat("chief", [
      message("m1", "user", "Fix the bug"),
      message("m2", "assistant", "Plan: read, fix, test", { status: "streaming", turnId: "turn-old" }),
      message("m3", "assistant", "Fixed"),
    ]);
    await sync.round();
    expect(texts(cloud.database, "copy-chief", "thread-copy")).toEqual([
      "user: Fix the bug",
      "assistant: Plan: read, fix, test",
      "assistant: Fixed",
    ]);
    expect(cloud.database.readConversation("copy-chief", "thread-copy").messages.map((entry) => entry.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("keeps the lock while the copy still answers", async () => {
    mac.chat.writeMainChat("chief", [message("m1", "user", "Hello")]);
    await sync.round();
    handoverBeforeUserMessage(cloud.store, cloud.database.connection, agent("copy-chief", "thread-copy"), null);
    await sync.round();
    cloud.chat.busyAgents.add("copy-chief");
    await expect(sync.bringBack("chief")).rejects.toThrow(
      sourceText("error.agent.handoverBusy", { server: "fikri-cloud" }),
    );
    expect(sync.states()[0]?.owner).toBe("copy");
  });

  it("leaves a task message alone and lets a copy's first session read the copied chat", async () => {
    mac.chat.writeMainChat("chief", [message("m1", "user", "Remember the blue logo")]);
    await sync.round();
    handoverBeforeUserMessage(cloud.store, cloud.database.connection, agent("copy-chief", "thread-copy"), "task-1");
    expect(cloud.store.incomingByAgent("copy-chief")?.owner).toBe("source");
    // What the copy's first provider session receives, read from the server's own database.
    const history = readHandoffHistory(cloud.database, "copy-chief", "thread-copy", new Map());
    const handoff = renderProviderHandoff(history, new Map(), new Map(), { copy: true });
    expect(handoff).toContain("Remember the blue logo");
    expect(handoff).toContain("copied from the user's computer");
  });
});
