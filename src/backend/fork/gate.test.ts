import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseForkConfig } from "./fork-config";
import { gateDecision, OBSERVATIONS_FILE_NAME, recordObservation } from "./gate";

const owner = { authorId: "111", isDirect: true };
const stranger = { authorId: "999", isDirect: false };

describe("gateDecision", () => {
  it("accepts everything without a gate, as upstream does", () => {
    expect(gateDecision(null, stranger)).toBe("accept");
  });

  it("drops everything when off", () => {
    expect(gateDecision({ mode: "off", allow: null }, owner)).toBe("drop");
  });

  it("in auto, accepts the allow-list and drops others; without a list accepts all", () => {
    const gate = { mode: "auto" as const, allow: new Set(["111"]) };
    expect(gateDecision(gate, owner)).toBe("accept");
    expect(gateDecision(gate, stranger)).toBe("drop");
    expect(gateDecision({ mode: "auto", allow: null }, stranger)).toBe("accept");
  });

  it("in observe, accepts the allow-list and only records others", () => {
    const gate = { mode: "observe" as const, allow: new Set(["111"]) };
    expect(gateDecision(gate, owner)).toBe("accept");
    expect(gateDecision(gate, stranger)).toBe("observe");
  });
});

describe("the gate block of fork-config.yaml", () => {
  it("reads each platform and refuses an unknown mode or platform", () => {
    const parsed = parseForkConfig('version: 1\ngate:\n  telegram:\n    mode: observe\n    allow: ["111"]\n');
    expect(parsed.ok && parsed.config.gates.get("telegram")).toEqual({ mode: "observe", allow: new Set(["111"]) });
    expect(parseForkConfig("version: 1\ngate:\n  telegram:\n    mode: maybe\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\ngate:\n  whatsapp:\n    mode: auto\n").ok).toBe(false);
  });
});

describe("recordObservation", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openbot-gate-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const base = {
    platform: "telegram",
    connectionId: "c",
    chatId: "-100",
    threadKey: "t0",
    authorId: "999",
    isDirect: false,
  };

  it("appends one redacted, cut line per observation", () => {
    recordObservation(root, { ...base, text: `hello ${"x".repeat(900)}` }, () => new Date("2026-11-02T12:00:00Z"));
    recordObservation(root, { ...base, text: "second" });
    const lines = readFileSync(join(root, OBSERVATIONS_FILE_NAME), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}");
    expect(first).toMatchObject({ at: "2026-11-02T12:00:00.000Z", platform: "telegram", authorId: "999" });
    expect(first.text).toHaveLength(500);
  });

  it("moves a full file aside", () => {
    writeFileSync(join(root, OBSERVATIONS_FILE_NAME), "x".repeat(2 * 1024 * 1024 + 10));
    recordObservation(root, { ...base, text: "new" });
    expect(readFileSync(join(root, OBSERVATIONS_FILE_NAME), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(root, `${OBSERVATIONS_FILE_NAME}.1`), "utf8").length).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("never throws when the folder is missing", () => {
    expect(() => recordObservation(join(root, "missing"), { ...base, text: "x" })).not.toThrow();
  });
});
