// Fork module (super-agent, roadmap item 4.2). A daily budget per agent, from `fork-config.yaml`.
//
// The budget counts the last 24 hours, not a calendar day, so it needs no time zone. Tokens are new
// input, cache writes and output; cached input reads are left out. The cost is OpenBot's estimate.
// When an agent has spent its budget, the drain holds its queue, like a plan limit: messages wait
// and none fails. A turn that already runs ends normally. The owner's own message in the app still
// starts a turn, so the owner can always ask the agent what happened. The hold ends by itself when
// older spending leaves the window, or when the owner raises the budget; the host checks the held
// agents every few minutes and schedules their drain again.

export interface BudgetLimit {
  /** The most tokens in 24 hours, or null for no limit. */
  dailyTokens: number | null;
  /** The most estimated US dollars in 24 hours, or null for no limit. */
  dailyUsd: number | null;
}

export interface Spend {
  tokens: number;
  costUsd: number;
}

export interface ForkBudgetOptions {
  /** The agent's spending since an ISO time. */
  read: (agentId: string, since: string) => Spend;
  /** The agent's budget, or null when it has none. */
  limitOf: (agentId: string) => BudgetLimit | null;
  /** Called once when an agent's queue starts to wait for its budget. */
  onHeld?: (agentId: string, spend: Spend, limit: BudgetLimit) => void;
  now?: () => number;
  /** How long one reading is used, so a drain does not read the database each time. */
  cacheMs?: number;
}

const DAY_MS = 24 * 60 * 60_000;

/** Whether this spending reaches the limit. */
export function budgetSpent(spend: Spend, limit: BudgetLimit): boolean {
  return (
    (limit.dailyTokens !== null && spend.tokens >= limit.dailyTokens) ||
    (limit.dailyUsd !== null && spend.costUsd >= limit.dailyUsd)
  );
}

/** The note for the owner and the logs; it names numbers only. */
export function budgetNote(agentId: string, spend: Spend, limit: BudgetLimit): string {
  const parts = [
    limit.dailyTokens !== null ? `${spend.tokens} of ${limit.dailyTokens} tokens` : null,
    limit.dailyUsd !== null ? `$${spend.costUsd.toFixed(2)} of $${limit.dailyUsd.toFixed(2)}` : null,
  ].filter((part) => part !== null);
  return `Agent ${agentId} reached its daily budget (${parts.join(", ")} in 24 hours); its queue waits. Raise the budget in fork-config.yaml or wait for the window to pass.`;
}

export class ForkBudget {
  readonly #options: ForkBudgetOptions;
  readonly #readings = new Map<string, { at: number; spent: boolean }>();
  readonly #held = new Set<string>();

  constructor(options: ForkBudgetOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #check(agentId: string): boolean {
    const limit = this.#options.limitOf(agentId);
    if (!limit || (limit.dailyTokens === null && limit.dailyUsd === null)) {
      this.#held.delete(agentId);
      return false;
    }
    const now = this.#now();
    const spend = this.#options.read(agentId, new Date(now - DAY_MS).toISOString());
    const spent = budgetSpent(spend, limit);
    this.#readings.set(agentId, { at: now, spent });
    if (spent && !this.#held.has(agentId)) {
      this.#held.add(agentId);
      this.#options.onHeld?.(agentId, spend, limit);
    }
    if (!spent) this.#held.delete(agentId);
    return spent;
  }

  /** Whether the agent's budget holds its queue now. A reading is used for `cacheMs`. */
  holds(agentId: string): boolean {
    const reading = this.#readings.get(agentId);
    if (reading && this.#now() - reading.at < (this.#options.cacheMs ?? 60_000)) return reading.spent;
    return this.#check(agentId);
  }

  /** Reads the held agents again and returns the ones whose budget no longer holds them. */
  released(): string[] {
    const released: string[] = [];
    for (const agentId of [...this.#held]) if (!this.#check(agentId)) released.push(agentId);
    return released;
  }

  /** The agents that wait for their budget. */
  held(): string[] {
    return [...this.#held];
  }
}

/** Spending at or above this share of a limit is a warning in `openbot doctor` (item 5.6). */
const BUDGET_WARN_SHARE = 0.8;

/** The highest share of a limit that this spending uses, from 0. */
export function budgetShare(spend: Spend, limit: BudgetLimit): number {
  return Math.max(
    limit.dailyTokens ? spend.tokens / limit.dailyTokens : 0,
    limit.dailyUsd ? spend.costUsd / limit.dailyUsd : 0,
  );
}

/** One doctor line for an agent's budget: ok, or a warning near or at the limit (item 5.6). */
export function budgetFinding(
  agentName: string,
  spend: Spend,
  limit: BudgetLimit,
): { level: "ok" | "warn"; check: string; detail: string; fix?: string } {
  const parts = [
    limit.dailyTokens !== null ? `${spend.tokens} of ${limit.dailyTokens} tokens` : null,
    limit.dailyUsd !== null ? `$${spend.costUsd.toFixed(2)} of $${limit.dailyUsd.toFixed(2)}` : null,
  ].filter((part) => part !== null);
  const share = budgetShare(spend, limit);
  const detail = `${agentName}: ${parts.join(", ")} in 24 hours (${Math.round(share * 100)}%).`;
  if (budgetSpent(spend, limit))
    return {
      level: "warn",
      check: "spend",
      detail: `${detail} Its queue waits for the budget.`,
      fix: "Raise its budget in fork-config.yaml, or wait for older spending to leave the 24-hour window.",
    };
  if (share >= BUDGET_WARN_SHARE)
    return {
      level: "warn",
      check: "spend",
      detail: `${detail} Near its daily budget.`,
      fix: "Check its work in the OpenBot app or with /tiket, or raise its budget.",
    };
  return { level: "ok", check: "spend", detail };
}
