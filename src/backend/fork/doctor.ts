// Fork module (super-agent, roadmap item 5.3). A check of the whole fork setup on one server, for the
// owner who runs OpenBot on a VPS for a team: roles, personas, global instructions, T3 Code, the
// gate, budgets and the backup. Each finding says what is wrong and how to fix it, so a bad edit is
// found before a person on Telegram finds it.
//
//   bun scripts/fork-doctor.ts [<OpenBot folder>]
//
// It reads files only and changes nothing. The ports keep it testable without a server.
//
// Item 5.10: with no fork-config.yaml, the finding carries a starting file with the server's real
// agent ids (the folder names, which people do not see in the app) and, on a server, the Telegram
// Orchestrator as the Router.

import { GLOBAL_INSTRUCTIONS_FILE_NAME, GLOBAL_INSTRUCTIONS_LIMIT } from "../agent/persona/persona-file";
import { PERSONA_FILE_NAME, parsePersona } from "../agent/persona/persona-schema";
import { FORK_CONFIG_FILE_NAME, type ForkRole, parseForkConfig } from "./fork-config";
import { ROLE_PERSONA_TEMPLATES } from "./role-templates";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
  level: DoctorLevel;
  check: string;
  detail: string;
  fix?: string;
  /** A file to start from, printed under the fix. */
  example?: string;
}

export interface DoctorAgent {
  id: string;
  name: string;
}

export interface DoctorPorts {
  /** The text of a file under the OpenBot folder, or null when it is missing. */
  readText(relativePath: string): string | null;
  /** Whether a folder exists under the OpenBot folder. */
  hasDir(relativePath: string): boolean;
  /** Whether a command is on PATH. */
  hasCommand(name: string): boolean;
  /** Whether an absolute path exists, for files outside the OpenBot folder such as the backup. */
  exists(path: string): boolean;
  platform: string;
  /** The agents of this server, for the starting file (item 5.10). */
  agents?(): DoctorAgent[];
  /** The agent that answers Telegram (the Orchestrator), or null when unknown. */
  routerHint?(): string | null;
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** A starting fork-config.yaml with these agents (item 5.10). Names go in comments only. */
export function suggestedForkConfig(agents: readonly DoctorAgent[], routerId: string | null): string {
  const comment = (text: string) => text.replace(/[\r\n]+/gu, " ").slice(0, 80);
  const lines = ["version: 1", "agents:"];
  const valid = agents.filter((agent) => AGENT_ID.test(agent.id));
  const router = valid.find((agent) => agent.id === routerId);
  if (router)
    lines.push(`  ${router.id}:   # ${comment(router.name)}: talks with people and routes work`, "    role: router");
  else lines.push("  # Give the Telegram Orchestrator role: router.");
  for (const agent of valid) {
    if (agent.id === router?.id) continue;
    lines.push(`  ${agent.id}:   # ${comment(agent.name)}`, "    role: worker");
  }
  lines.push(
    "  # Add a Watchdog agent with role: watchdog (docs/fork/agents/README.md).",
    "chat:",
    "  maxWords: 100",
    "gate:",
    "  telegram:",
    "    mode: auto",
    '    # allow: ["123456789"]   # your team\'s Telegram user ids; without it, anyone can give work',
    "# budget:",
    "#   dailyUsd: 5",
  );
  return lines.join("\n");
}

const ok = (check: string, detail: string): DoctorFinding => ({ level: "ok", check, detail });
const warn = (check: string, detail: string, fix: string): DoctorFinding => ({ level: "warn", check, detail, fix });
const error = (check: string, detail: string, fix: string): DoctorFinding => ({ level: "error", check, detail, fix });

export function forkDoctor(ports: DoctorPorts): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const text = ports.readText(FORK_CONFIG_FILE_NAME);
  if (text === null) {
    const agents = ports.agents?.() ?? [];
    findings.push({
      ...warn(
        "fork-config",
        `${FORK_CONFIG_FILE_NAME} is missing: no agent has a role, so the Router limits, the ticket roles and the Watchdog are off.`,
        agents.length
          ? `Write it beside Agents and Shared, starting from this (check each role); see docs/fork/fork-config.md.`
          : "Write it beside Agents and Shared; see docs/fork/fork-config.md.",
      ),
      ...(agents.length ? { example: suggestedForkConfig(agents, ports.routerHint?.() ?? null) } : {}),
    });
    return [...findings, ...personaFindings(ports, new Map()), ...globalFindings(ports)];
  }
  const parsed = parseForkConfig(text);
  if (!parsed.ok) {
    findings.push(
      error(
        "fork-config",
        `${FORK_CONFIG_FILE_NAME} is not valid: ${parsed.issue} OpenBot keeps the last valid version of this process; after a restart it has none.`,
        "Fix the field it names; see docs/fork/fork-config.md.",
      ),
    );
    return [...findings, ...personaFindings(ports, new Map()), ...globalFindings(ports)];
  }
  const config = parsed.config;
  findings.push(ok("fork-config", `${FORK_CONFIG_FILE_NAME} is valid, with ${config.roles.size} role(s).`));

  const agentIds = new Set([...config.roles.keys(), ...config.agentBudgets.keys()]);
  for (const agentId of agentIds)
    if (!ports.hasDir(`Agents/${agentId}`))
      findings.push(
        error(
          "agents",
          `fork-config.yaml names the agent ${agentId}, but Agents/${agentId} does not exist.`,
          "Use the agent's id (the name of its folder in Agents), not its display name.",
        ),
      );

  const byRole = (role: string) => [...config.roles].filter(([, value]) => value === role).map(([id]) => id);
  const routers = byRole("router");
  const workers = byRole("worker");
  findings.push(
    routers.length
      ? ok("router", `The Router is ${routers[0]}.`)
      : warn("router", "No agent has the role router.", "Give the Telegram Orchestrator `role: router`."),
  );
  findings.push(
    workers.length
      ? ok("workers", `Workers: ${workers.join(", ")}.`)
      : warn(
          "workers",
          "No agent has the role worker, so the Router has nobody to give a ticket to.",
          "Give the Coder or Researcher `role: worker`.",
        ),
  );
  findings.push(
    byRole("watchdog").length
      ? ok("watchdog", `The Watchdog is ${byRole("watchdog")[0]}.`)
      : warn(
          "watchdog",
          "No agent has the role watchdog: stuck tickets are not checked.",
          "Add a Watchdog agent; see docs/fork/agents/README.md.",
        ),
  );

  const t3Command = config.t3?.command?.[0] ?? "t3";
  if (config.t3 || workers.length) {
    findings.push(
      ports.hasCommand(t3Command)
        ? ok("t3", `The T3 Code command ${t3Command} is on PATH.`)
        : warn(
            "t3",
            `The T3 Code command ${t3Command} is not on PATH, so t3_run fails for coding tickets.`,
            "Install T3 Code for the service user, or set t3.command; see docs/fork/t3.md.",
          ),
    );
  }

  const telegram = config.gates.get("telegram");
  if (!telegram || telegram.mode === "off")
    findings.push(
      warn(
        "gate",
        telegram
          ? "The Telegram gate is off: every message is dropped."
          : "No Telegram gate: anyone who can message the bot can give it work.",
        "Set gate.telegram with mode auto and an allow list of Telegram user ids.",
      ),
    );
  else if (!telegram.allow)
    findings.push(
      warn(
        "gate",
        `The Telegram gate is ${telegram.mode} with no allow list.`,
        "Add gate.telegram.allow with your team's Telegram user ids.",
      ),
    );
  else findings.push(ok("gate", `The Telegram gate is ${telegram.mode} for ${telegram.allow.size} user(s).`));

  findings.push(
    config.budget || config.agentBudgets.size
      ? ok("budget", "A daily budget is set.")
      : warn(
          "budget",
          "No daily budget: an agent in a loop can spend without a limit.",
          "Set budget.dailyUsd or budget.dailyTokens; see docs/fork/fork-config.md.",
        ),
  );

  if (ports.platform === "linux")
    findings.push(
      ports.exists("/usr/local/bin/openbot-backup")
        ? ok("backup", "The daily backup is installed.")
        : warn(
            "backup",
            "The daily backup is not installed.",
            "sudo bash scripts/fork/openbot-backup install; see docs/fork/storage.md.",
          ),
    );

  return [...findings, ...personaFindings(ports, config.roles), ...globalFindings(ports)];
}

function personaFindings(ports: DoctorPorts, roles: ReadonlyMap<string, ForkRole>): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const [agentId, role] of roles) {
    if (!ports.hasDir(`Agents/${agentId}`)) continue;
    const text = ports.readText(`Agents/${agentId}/${PERSONA_FILE_NAME}`);
    if (text === null) {
      // The Router and the Watchdog get their role's template at their next session (item P.7).
      findings.push(
        role in ROLE_PERSONA_TEMPLATES
          ? ok("persona", `${agentId} has no persona.yaml yet; the ${role} template is written at its next session.`)
          : warn(
              "persona",
              `${agentId} has no persona.yaml.`,
              `Copy a template from docs/fork/agents/ to Agents/${agentId}/persona.yaml.`,
            ),
      );
      continue;
    }
    const parsed = parsePersona(text);
    if (!parsed.ok) {
      findings.push(
        error(
          "persona",
          `${agentId}: persona.yaml is ignored: ${parsed.issue}`,
          `bun scripts/persona.ts validate Agents/${agentId}/persona.yaml`,
        ),
      );
      continue;
    }
    // Item 5.11: the Router picks a worker by its routing summary in list_agents.
    if (role === "worker" && !parsed.persona.routing_summary?.trim()) {
      findings.push(
        warn(
          "persona",
          `${agentId}: persona.yaml has no routing_summary, so the Router sees only the profile description when it picks a worker.`,
          "Add one line on what this worker does and when to send it work, such as: routing_summary: Fixes and builds code in T3 Code.",
        ),
      );
      continue;
    }
    findings.push(ok("persona", `${agentId}: persona.yaml is valid.`));
  }
  return findings;
}

function globalFindings(ports: DoctorPorts): DoctorFinding[] {
  const text = ports.readText(GLOBAL_INSTRUCTIONS_FILE_NAME);
  if (text === null || text.trim().length <= GLOBAL_INSTRUCTIONS_LIMIT) return [];
  return [
    warn(
      "global-instructions",
      `${GLOBAL_INSTRUCTIONS_FILE_NAME} has ${text.trim().length} characters; only ${GLOBAL_INSTRUCTIONS_LIMIT} are used.`,
      "Shorten it, or move agent-specific parts to that agent's persona.yaml.",
    ),
  ];
}

/** The findings as text lines for a terminal. */
export function doctorReport(findings: readonly DoctorFinding[]): string {
  const mark: Record<DoctorLevel, string> = { ok: "ok   ", warn: "warn ", error: "ERROR" };
  return findings
    .map(
      (finding) =>
        `${mark[finding.level]} ${finding.check}: ${finding.detail}${finding.fix ? `\n      → ${finding.fix}` : ""}${
          finding.example ? `\n${finding.example.replace(/^/gmu, "        ")}` : ""
        }`,
    )
    .join("\n");
}
