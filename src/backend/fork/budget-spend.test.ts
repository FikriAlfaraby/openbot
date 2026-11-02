import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "../effect-boundary";
import { OpenBotDatabase } from "../openbot-database";

describe("AgentUsage.readSpendSince", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("adds an agent's new input, cache writes and output since a time, not cached reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-budget-spend-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await runCauseEffect(database.initialize());
    const at = new Date().toISOString();
    database.usage.startTurn("coder", "session-1", "turn-1", "claude", "claude-sonnet-4-5");
    database.usage.record({
      agentId: "coder",
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "claude",
      model: "claude-sonnet-4-5",
      counterId: "counter-1",
      tokens: { uncachedInput: 1_000, cachedInput: 50_000, cacheCreation: 200, output: 300 },
      baseline: false,
      occurredAt: at,
    });
    database.usage.record({
      agentId: "other",
      sessionId: "session-2",
      turnId: "turn-2",
      provider: "claude",
      model: "claude-sonnet-4-5",
      counterId: "counter-2",
      tokens: { uncachedInput: 9_000, cachedInput: 0, cacheCreation: 0, output: 0 },
      baseline: false,
      occurredAt: at,
    });
    const since = new Date(Date.parse(at) - 60_000).toISOString();
    expect(database.usage.readSpendSince("coder", since).tokens).toBe(1_500);
    expect(database.usage.readSpendSince("coder", new Date(Date.parse(at) + 60_000).toISOString())).toEqual({
      tokens: 0,
      costUsd: 0,
    });
    database.close();
  });
});
