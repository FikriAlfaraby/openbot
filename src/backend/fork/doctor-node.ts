// Fork module (super-agent, roadmap item 5.4). The doctor's ports on a real file system, shared by
// `bun scripts/fork-doctor.ts` and the server's `openbot doctor` (the control socket route
// `GET /v1/fork/doctor`, which runs inside OpenBot, so the server needs no `bun`).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type DoctorFinding, doctorReport, forkDoctor } from "./doctor";

export function runForkDoctor(
  openbotRoot: string,
  extra: readonly DoctorFinding[] = [],
): { findings: DoctorFinding[]; report: string; errors: number } {
  const checked = forkDoctor({
    readText: (path) => {
      try {
        return readFileSync(join(openbotRoot, path), "utf8");
      } catch {
        return null;
      }
    },
    hasDir: (path) => {
      try {
        return statSync(join(openbotRoot, path)).isDirectory();
      } catch {
        return false;
      }
    },
    hasCommand: (name) =>
      spawnSync("sh", ["-c", 'command -v "$1"', "sh", name], { stdio: "ignore", timeout: 5_000 }).status === 0,
    exists: (path) => existsSync(path),
    platform: process.platform,
  });
  // Checks that need the running OpenBot, such as the spending of each agent (item 5.6).
  const findings = [...checked, ...extra];
  return {
    findings,
    report: doctorReport(findings),
    errors: findings.filter((finding) => finding.level === "error").length,
  };
}

/** The control socket answer of `GET /v1/fork/doctor`: one line per key, so the report is base64. */
export function doctorAnswerLines(result: { report: string; errors: number }): { errors: number; report: string } {
  return { errors: result.errors, report: Buffer.from(result.report, "utf8").toString("base64") };
}
