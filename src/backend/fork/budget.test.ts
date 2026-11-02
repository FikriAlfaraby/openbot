import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetFinding, budgetNote, budgetShare, budgetSpent, ForkBudget, type Spend } from "./budget";
import { runForkDoctor } from "./doctor-node";
import { FORK_CONFIG_FILE_NAME, parseForkConfig } from "./fork-config";
import { forkBudgetOf, forkRoleOf } from "./router-policy";

describe("budgetSpent", () => {
  it("holds at the token or the dollar limit", () => {
    expect(budgetSpent({ tokens: 999, costUsd: 0 }, { dailyTokens: 1_000, dailyUsd: null })).toBe(false);
    expect(budgetSpent({ tokens: 1_000, costUsd: 0 }, { dailyTokens: 1_000, dailyUsd: null })).toBe(true);
    expect(budgetSpent({ tokens: 0, costUsd: 2 }, { dailyTokens: null, dailyUsd: 2 })).toBe(true);
    expect(budgetSpent({ tokens: 10, costUsd: 10 }, { dailyTokens: null, dailyUsd: null })).toBe(false);
  });

  it("names numbers only", () => {
    expect(budgetNote("coder", { tokens: 5_000, costUsd: 1.5 }, { dailyTokens: 4_000, dailyUsd: 1 })).toContain(
      "5000 of 4000 tokens, $1.50 of $1.00",
    );
  });
});

describe("ForkBudget", () => {
  function setup(limit: { dailyTokens: number | null; dailyUsd: number | null } | null) {
    let now = 1_900_000_000_000;
    let spend: Spend = { tokens: 0, costUsd: 0 };
    const reads: string[] = [];
    const held: string[] = [];
    const budget = new ForkBudget({
      read: (_agentId, since) => {
        reads.push(since);
        return spend;
      },
      limitOf: () => limit,
      onHeld: (agentId) => held.push(agentId),
      now: () => now,
      cacheMs: 60_000,
    });
    return {
      budget,
      reads,
      held,
      spend: (next: Spend) => {
        spend = next;
      },
      advance: (ms: number) => {
        now += ms;
      },
      now: () => now,
    };
  }

  it("holds nothing without a limit and reads nothing", () => {
    const test = setup(null);
    expect(test.budget.holds("coder")).toBe(false);
    expect(test.reads).toEqual([]);
  });

  it("reads the last 24 hours, caches the reading, and tells once", () => {
    const test = setup({ dailyTokens: 1_000, dailyUsd: null });
    test.spend({ tokens: 1_500, costUsd: 0 });
    expect(test.budget.holds("coder")).toBe(true);
    expect(test.reads).toEqual([new Date(test.now() - 86_400_000).toISOString()]);
    expect(test.budget.holds("coder")).toBe(true);
    expect(test.reads).toHaveLength(1);
    test.advance(61_000);
    expect(test.budget.holds("coder")).toBe(true);
    expect(test.reads).toHaveLength(2);
    expect(test.held).toEqual(["coder"]);
    expect(test.budget.held()).toEqual(["coder"]);
  });

  it("releases an agent when older spending leaves the window", () => {
    const test = setup({ dailyTokens: 1_000, dailyUsd: null });
    test.spend({ tokens: 1_500, costUsd: 0 });
    expect(test.budget.holds("coder")).toBe(true);
    expect(test.budget.released()).toEqual([]);
    test.spend({ tokens: 200, costUsd: 0 });
    expect(test.budget.released()).toEqual(["coder"]);
    expect(test.budget.held()).toEqual([]);
    expect(test.budget.holds("coder")).toBe(false);
  });
});

describe("budget in fork-config.yaml", () => {
  it("takes a default budget and an agent's own, and an agent entry without a role", () => {
    const parsed = parseForkConfig(
      "version: 1\nbudget:\n  dailyTokens: 2000000\n  dailyUsd: 5\nagents:\n  coder:\n    dailyTokens: 500000\n  orchestrator:\n    role: router\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.budget).toEqual({ dailyTokens: 2_000_000, dailyUsd: 5 });
    expect(parsed.config.agentBudgets.get("coder")).toEqual({ dailyTokens: 500_000 });
    expect(parsed.config.roles.has("coder")).toBe(false);
    expect(parsed.config.roles.get("orchestrator")).toBe("router");
  });

  it("refuses a budget out of range", () => {
    expect(parseForkConfig("version: 1\nbudget:\n  dailyTokens: 10\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\nagents:\n  coder:\n    dailyUsd: -1\n").ok).toBe(false);
  });

  it("gives an agent its own budget over the default", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-budget-"));
    try {
      mkdirSync(join(root, "Shared"));
      const sharedRoot = join(root, "Shared");
      expect(forkBudgetOf(sharedRoot, "coder")).toBeNull();
      const path = join(root, FORK_CONFIG_FILE_NAME);
      writeFileSync(path, "version: 1\nbudget:\n  dailyUsd: 5\nagents:\n  coder:\n    dailyTokens: 500000\n");
      utimesSync(path, 1_900_000_000, 1_900_000_000);
      expect(forkBudgetOf(sharedRoot, "coder")).toEqual({ dailyTokens: 500_000, dailyUsd: 5 });
      expect(forkBudgetOf(sharedRoot, "router")).toEqual({ dailyTokens: null, dailyUsd: 5 });
      expect(forkRoleOf(sharedRoot, "coder")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("budget in openbot doctor (item 5.6)", () => {
  it("is ok below 80%, a warning near the limit and at it", () => {
    const limit = { dailyTokens: 1_000, dailyUsd: 10 };
    expect(budgetShare({ tokens: 500, costUsd: 9 }, limit)).toBeCloseTo(0.9);
    expect(budgetFinding("Coder", { tokens: 100, costUsd: 1 }, limit)).toMatchObject({
      level: "ok",
      detail: "Coder: 100 of 1000 tokens, $1.00 of $10.00 in 24 hours (10%).",
    });
    expect(budgetFinding("Coder", { tokens: 850, costUsd: 1 }, limit)).toMatchObject({ level: "warn" });
    expect(budgetFinding("Coder", { tokens: 850, costUsd: 1 }, limit).detail).toContain("Near its daily budget");
    expect(budgetFinding("Coder", { tokens: 0, costUsd: 10 }, limit).detail).toContain("Its queue waits");
  });

  it("joins the server's findings to the file checks", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-budget-doctor-"));
    try {
      mkdirSync(join(root, "Agents"));
      const extra = [budgetFinding("Coder", { tokens: 0, costUsd: 10 }, { dailyTokens: null, dailyUsd: 10 })];
      const result = runForkDoctor(root, extra);
      expect(result.report).toContain("warn  spend: Coder: $10.00 of $10.00 in 24 hours (100%).");
      expect(result.errors).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
