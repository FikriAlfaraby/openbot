import { describe, expect, it } from "vitest";
import { buildMandate, mandateHolds, parseMandate } from "./mandate";

const now = () => new Date("2026-11-02T12:00:00Z");
const allow = { mode: "auto" as const, allow: new Set(["111"]) };

describe("buildMandate and parseMandate", () => {
  it("round-trips and cuts the scope", () => {
    const mandate = buildMandate(
      { sender: { platform: "telegram", authorId: "111" } },
      allow,
      `  ${"s".repeat(600)} `,
      now,
    );
    expect(mandate.strength).toBe("explicit");
    expect(mandate.scope).toHaveLength(500);
    expect(parseMandate(JSON.stringify(mandate))).toEqual(mandate);
    expect(parseMandate("not json")).toBeNull();
    expect(parseMandate(JSON.stringify({ version: 2 }))).toBeNull();
  });
});

describe("mandateHolds", () => {
  const mandate = JSON.stringify(buildMandate({ sender: { platform: "telegram", authorId: "111" } }, allow, "x", now));

  it("holds while the sender is allowed, and reports a changed policy", () => {
    expect(mandateHolds(mandate, () => allow)).toEqual({ ok: true, policyChanged: false });
    expect(mandateHolds(mandate, () => ({ mode: "observe", allow: new Set(["111", "222"]) }))).toEqual({
      ok: true,
      policyChanged: true,
    });
  });

  it("is revoked when the sender leaves the list or the gate is off", () => {
    expect(mandateHolds(mandate, () => ({ mode: "auto", allow: new Set(["222"]) })).ok).toBe(false);
    expect(mandateHolds(mandate, () => ({ mode: "off", allow: null })).ok).toBe(false);
  });

  it("holds for tickets with no mandate and for agent work", () => {
    expect(mandateHolds(null, () => ({ mode: "off", allow: null })).ok).toBe(true);
    const agent = JSON.stringify(buildMandate({ sender: null }, null, "routine", now));
    expect(mandateHolds(agent, () => ({ mode: "off", allow: null })).ok).toBe(true);
  });
});
