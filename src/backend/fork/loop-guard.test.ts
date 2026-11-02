import { describe, expect, it } from "vitest";
import { callSignature, LoopGuard } from "./loop-guard";

describe("callSignature", () => {
  it("ignores key order and tells inputs apart", () => {
    expect(callSignature("t3_run", { a: 1, b: { c: 2, d: 3 } })).toBe(
      callSignature("t3_run", { b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(callSignature("t3_run", { a: 1 })).not.toBe(callSignature("t3_run", { a: 2 }));
    expect(callSignature("t3_run", { a: 1 })).not.toBe(callSignature("t3_show", { a: 1 }));
  });
});

describe("LoopGuard", () => {
  function setup() {
    let now = 0;
    const guard = new LoopGuard({ failures: 3, windowMs: 600_000, now: () => now });
    return { guard, advance: (ms: number) => (now += ms) };
  }

  it("refuses the same call after three failures in a row", () => {
    const { guard } = setup();
    for (let i = 0; i < 2; i++) guard.record("coder", "t3_run", { ticket: 4 }, false);
    expect(guard.refusal("coder", "t3_run", { ticket: 4 })).toBeNull();
    guard.record("coder", "t3_run", { ticket: 4 }, false);
    expect(guard.refusal("coder", "t3_run", { ticket: 4 })).toContain("failed 3 times in a row");
    expect(guard.refusal("coder", "t3_run", { ticket: 5 })).toBeNull();
    expect(guard.refusal("router", "t3_run", { ticket: 4 })).toBeNull();
  });

  it("starts again after a success or when the window passed", () => {
    const { guard, advance } = setup();
    for (let i = 0; i < 3; i++) guard.record("coder", "ticket_read", { ticket: 1 }, false);
    guard.record("coder", "ticket_read", { ticket: 1 }, true);
    expect(guard.refusal("coder", "ticket_read", { ticket: 1 })).toBeNull();
    for (let i = 0; i < 3; i++) guard.record("coder", "ticket_read", { ticket: 1 }, false);
    advance(600_001);
    expect(guard.refusal("coder", "ticket_read", { ticket: 1 })).toBeNull();
    guard.record("coder", "ticket_read", { ticket: 1 }, false);
    expect(guard.refusal("coder", "ticket_read", { ticket: 1 })).toBeNull();
  });

  it("does not count failures spread wider than the window", () => {
    const { guard, advance } = setup();
    guard.record("coder", "t3_show", {}, false);
    advance(700_000);
    guard.record("coder", "t3_show", {}, false);
    guard.record("coder", "t3_show", {}, false);
    expect(guard.refusal("coder", "t3_show", {})).toBeNull();
  });
});
