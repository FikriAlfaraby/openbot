import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePersona } from "../agent/persona/persona-schema";
import { starterPersonaText, writeStarterPersona } from "./starter-persona";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "openbot-starter-persona-"));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("starterPersonaText", () => {
  it("makes a valid persona from the title and the first sentence of the description", () => {
    const text = starterPersonaText({
      name: "Coder",
      title: "Software engineer",
      description: "Fixes bugs and writes tests. Works in T3 Code.",
    });
    const parsed = parsePersona(text ?? "");
    expect(parsed.ok && parsed.persona).toMatchObject({
      role: "Software engineer",
      goals: ["Fixes bugs and writes tests."],
      routing_summary: "Fixes bugs and writes tests.",
    });
  });

  it("uses the name without a title, and leaves goals out without a description", () => {
    const parsed = parsePersona(starterPersonaText({ name: "Helper", title: " ", description: "" }) ?? "");
    expect(parsed.ok && parsed.persona.role).toBe("Helper");
    expect(parsed.ok && parsed.persona.goals).toBeUndefined();
  });

  it("keeps YAML-special text valid", () => {
    const text = starterPersonaText({ name: "x", title: "Ops: #1 - deploys", description: "Says 'yes': always" });
    expect(parsePersona(text ?? "").ok).toBe(true);
  });
});

describe("writeStarterPersona", () => {
  it("writes once and never replaces a persona", async () => {
    const profile = { name: "Coder", title: "Engineer", description: "Codes." };
    expect(await Effect.runPromise(writeStarterPersona(workspace, profile))).toBe(true);
    writeFileSync(join(workspace, "persona.yaml"), "role: Owner's own\n");
    expect(await Effect.runPromise(writeStarterPersona(workspace, profile))).toBe(false);
    expect(readFileSync(join(workspace, "persona.yaml"), "utf8")).toBe("role: Owner's own\n");
  });
});
