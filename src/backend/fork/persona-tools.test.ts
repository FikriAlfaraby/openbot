import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPersonaVersions } from "../agent/persona/persona-history";
import { handlePersonaTool, removedBoundaries } from "./persona-tools";
import { routerMayUse } from "./router-policy";

let workspace: string;
const run = (tool: "persona_read" | "persona_update", args: unknown) =>
  Effect.runPromise(handlePersonaTool(workspace, tool, args));

const BASE = "role: Coder\nboundaries:\n  - Do not merge without approval.\n";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "openbot-persona-tools-"));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("persona_read", () => {
  it("reads no persona, then the text, fields and hash", async () => {
    expect(await run("persona_read", {})).toMatchObject({ ok: true, value: { exists: false, hash: null } });
    writeFileSync(join(workspace, "persona.yaml"), BASE);
    expect(await run("persona_read", {})).toMatchObject({
      ok: true,
      value: { exists: true, persona: { role: "Coder" }, text: BASE },
    });
  });
});

describe("persona_update", () => {
  it("writes a valid persona and records versions before and after", async () => {
    writeFileSync(join(workspace, "persona.yaml"), BASE);
    const read = await run("persona_read", {});
    const hash =
      read.ok && typeof read.value === "object" && read.value && "hash" in read.value ? String(read.value.hash) : "";
    const next = `${BASE}  - Never deploy on Friday.\ntone: Brief.\n`;
    const saved = await run("persona_update", { yaml: next, expectedHash: hash });
    expect(saved).toMatchObject({ ok: true, value: { version: 2 } });
    expect(readFileSync(join(workspace, "persona.yaml"), "utf8")).toBe(next);
    expect((await Effect.runPromise(listPersonaVersions(workspace))).map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("refuses an invalid persona with the field", async () => {
    expect(await run("persona_update", { yaml: "role: x\nmood: happy\n" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid"),
    });
  });

  it("refuses to remove or reword a boundary", async () => {
    writeFileSync(join(workspace, "persona.yaml"), BASE);
    const result = await run("persona_update", { yaml: "role: Coder\nboundaries:\n  - Merge when tests pass.\n" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Do not merge without approval.") });
    expect(readFileSync(join(workspace, "persona.yaml"), "utf8")).toBe(BASE);
  });

  it("refuses a stale hash", async () => {
    writeFileSync(join(workspace, "persona.yaml"), BASE);
    expect(await run("persona_update", { yaml: `${BASE}tone: x\n`, expectedHash: "0000" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed since"),
    });
  });
});

describe("removedBoundaries and the Router", () => {
  it("lists dropped boundaries only", () => {
    expect(removedBoundaries(BASE, `${BASE}  - another\n`)).toEqual([]);
    expect(removedBoundaries(BASE, "role: x\n")).toEqual(["Do not merge without approval."]);
  });

  it("lets the Router use its persona tools", () => {
    expect(routerMayUse("openbot", "persona_update")).toBe(true);
  });
});
