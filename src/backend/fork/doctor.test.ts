import { describe, expect, it } from "vitest";
import { type DoctorPorts, doctorReport, forkDoctor, suggestedForkConfig } from "./doctor";
import { parseForkConfig } from "./fork-config";

function ports(
  files: Record<string, string>,
  dirs: string[] = [],
  commands: string[] = [],
  paths: string[] = [],
): DoctorPorts {
  return {
    readText: (path) => files[path] ?? null,
    hasDir: (path) => dirs.includes(path),
    hasCommand: (name) => commands.includes(name),
    exists: (path) => paths.includes(path),
    platform: "linux",
  };
}

const levelOf = (findings: ReturnType<typeof forkDoctor>, check: string) =>
  findings.filter((finding) => finding.check === check).map((finding) => finding.level);

describe("forkDoctor", () => {
  it("warns that roles are off without fork-config.yaml", () => {
    const findings = forkDoctor(ports({}));
    expect(levelOf(findings, "fork-config")).toEqual(["warn"]);
  });

  it("fails an invalid fork-config.yaml and names the field", () => {
    const findings = forkDoctor(ports({ "fork-config.yaml": "version: 1\nagents:\n  bot:\n    role: boss\n" }));
    expect(levelOf(findings, "fork-config")).toEqual(["error"]);
    expect(findings[0]?.detail).toContain("not valid");
  });

  it("passes a full setup", () => {
    const config = [
      "version: 1",
      "agents:",
      "  router1: { role: router }",
      "  coder: { role: worker }",
      "  dog: { role: watchdog }",
      "budget: { dailyUsd: 5 }",
      "gate:",
      "  telegram: { mode: auto, allow: ['123'] }",
    ].join("\n");
    const persona = "version: 1\nrole: Router\n";
    const findings = forkDoctor(
      ports(
        {
          "fork-config.yaml": config,
          "Agents/router1/persona.yaml": persona,
          "Agents/coder/persona.yaml": persona,
          "Agents/dog/persona.yaml": persona,
        },
        ["Agents/router1", "Agents/coder", "Agents/dog"],
        ["t3"],
        ["/usr/local/bin/openbot-backup"],
      ),
    );
    expect(findings.filter((finding) => finding.level !== "ok")).toEqual([]);
    expect(doctorReport(findings)).toContain("ok    router: The Router is router1.");
  });

  it("finds a missing agent folder, a bad persona, no T3, an open gate, no budget and no backup", () => {
    const findings = forkDoctor(
      ports(
        {
          "fork-config.yaml": "version: 1\nagents:\n  coder: { role: worker }\n  ghost: { role: watchdog }\n",
          "Agents/coder/persona.yaml": "version: 1\nunknown: x\n",
          "global-instructions.md": "x".repeat(9_000),
        },
        ["Agents/coder"],
      ),
    );
    expect(levelOf(findings, "agents")).toEqual(["error"]);
    expect(levelOf(findings, "persona")).toEqual(["error"]);
    expect(levelOf(findings, "router")).toEqual(["warn"]);
    expect(levelOf(findings, "t3")).toEqual(["warn"]);
    expect(levelOf(findings, "gate")).toEqual(["warn"]);
    expect(levelOf(findings, "budget")).toEqual(["warn"]);
    expect(levelOf(findings, "backup")).toEqual(["warn"]);
    expect(levelOf(findings, "global-instructions")).toEqual(["warn"]);
    expect(doctorReport(findings)).toContain("→ ");
  });
});

describe("the starting fork-config.yaml (item 5.10)", () => {
  const agents = [
    { id: "orchestrator", name: "Telegram Orchestrator" },
    { id: "coder", name: "Coder\n# role: router" },
    { id: "bad id", name: "x" },
  ];

  it("is valid, names the Router and the workers, and keeps names in comments", () => {
    const text = suggestedForkConfig(agents, "orchestrator");
    const parsed = parseForkConfig(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.fromEntries(parsed.config.roles)).toEqual({ orchestrator: "router", coder: "worker" });
    expect(parsed.config.gates.get("telegram")).toEqual({ mode: "auto", allow: null });
    expect(parsed.config.budget).toBeNull();
    expect(text).not.toContain("bad id");
  });

  it("asks for the Router when the Orchestrator is unknown", () => {
    const text = suggestedForkConfig(agents, null);
    const parsed = parseForkConfig(text);
    expect(parsed.ok && [...parsed.config.roles.values()]).toEqual(["worker", "worker"]);
    expect(text).toContain("Give the Telegram Orchestrator role: router.");
  });

  it("comes with the missing-file finding, indented in the report", () => {
    const findings = forkDoctor({ ...ports({}), agents: () => agents, routerHint: () => "orchestrator" });
    expect(findings[0]?.example).toContain("role: router");
    expect(doctorReport(findings)).toContain("\n        version: 1\n        agents:");
    expect(forkDoctor(ports({}))[0]?.example).toBeUndefined();
  });
});
