import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePersona } from "../agent/persona/persona-schema";
import { applyRoleTemplate, ROLE_PERSONA_TEMPLATES } from "./role-templates";
import { starterPersonaText } from "./starter-persona";

const ROOT = resolve(import.meta.dirname, "../../..");
const profile = { name: "Router", title: "Router", description: "Routes work." };
let workspace: string;
const persona = () => readFileSync(join(workspace, "persona.yaml"), "utf8");
const apply = (role: "router" | "watchdog" | "worker" | null) =>
  Effect.runPromise(applyRoleTemplate(workspace, role, profile));

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "openbot-role-templates-"));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("ROLE_PERSONA_TEMPLATES", () => {
  it("are valid and equal to the templates in docs/fork/agents", () => {
    for (const role of ["router", "watchdog"] as const) {
      const text = ROLE_PERSONA_TEMPLATES[role] ?? "";
      expect(parsePersona(text).ok).toBe(true);
      expect(text).toBe(readFileSync(join(ROOT, "docs/fork/agents", `${role}.persona.yaml`), "utf8"));
    }
  });
});

describe("applyRoleTemplate", () => {
  it("writes the template when the workspace has no persona", async () => {
    expect(await apply("router")).toBe(true);
    expect(persona()).toBe(ROLE_PERSONA_TEMPLATES.router);
    expect(await apply("router")).toBe(false);
  });

  it("replaces an unchanged starter, but never an edited persona", async () => {
    writeFileSync(join(workspace, "persona.yaml"), starterPersonaText(profile) ?? "");
    expect(await apply("watchdog")).toBe(true);
    expect(persona()).toBe(ROLE_PERSONA_TEMPLATES.watchdog);
    writeFileSync(join(workspace, "persona.yaml"), "role: The owner's own router\n");
    expect(await apply("router")).toBe(false);
    expect(persona()).toBe("role: The owner's own router\n");
  });

  it("does nothing for a worker or an agent without a role", async () => {
    expect(await apply("worker")).toBe(false);
    expect(await apply(null)).toBe(false);
  });
});
