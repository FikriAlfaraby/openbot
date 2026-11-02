import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorAnswerLines, runForkDoctor } from "./doctor-node";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openbot-doctor-"));
  mkdirSync(join(root, "Agents", "orchestrator"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("runForkDoctor", () => {
  it("reads a real OpenBot folder", () => {
    writeFileSync(
      join(root, "fork-config.yaml"),
      "version: 1\nagents:\n  orchestrator: { role: router }\n  missing: { role: worker }\n",
    );
    writeFileSync(join(root, "Agents", "orchestrator", "persona.yaml"), "version: 1\nrole: Router\n");
    const result = runForkDoctor(root);
    expect(result.errors).toBe(1);
    expect(result.report).toContain("Agents/missing does not exist");
    expect(result.report).toContain("orchestrator: persona.yaml is valid.");
  });

  it("answers the control socket in one line per key, the report as base64", () => {
    const lines = doctorAnswerLines({ report: "ok    router: x\nwarn  gate: y\n      → z", errors: 0 });
    expect(lines.errors).toBe(0);
    expect(lines.report).not.toMatch(/\n/u);
    expect(Buffer.from(lines.report, "base64").toString("utf8")).toBe("ok    router: x\nwarn  gate: y\n      → z");
  });
});
