// Fork tool (super-agent, roadmap item 5.3). Checks the fork setup of one OpenBot folder.
//
//   bun scripts/fork-doctor.ts [<OpenBot folder>]
//
// The folder holds Agents, Shared and fork-config.yaml: ~/OpenBot on a desktop,
// /var/lib/openbot/OpenBot on a self-hosted server (the default when it exists). Exits 1 when a
// check fails. It reads files only.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { doctorReport, forkDoctor } from "../src/backend/fork/doctor";

const SERVER_ROOT = "/var/lib/openbot/OpenBot";
const root = resolve(process.argv[2] ?? (existsSync(SERVER_ROOT) ? SERVER_ROOT : join(homedir(), "OpenBot")));
if (!existsSync(join(root, "Agents"))) {
  process.stderr.write(`${root} has no Agents folder. Usage: bun scripts/fork-doctor.ts [<OpenBot folder>]\n`);
  process.exit(2);
}

const findings = forkDoctor({
  readText: (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  },
  hasDir: (path) => {
    try {
      return statSync(join(root, path)).isDirectory();
    } catch {
      return false;
    }
  },
  hasCommand: (name) => spawnSync("sh", ["-c", 'command -v "$1"', "sh", name], { stdio: "ignore" }).status === 0,
  exists: (path) => existsSync(path),
  platform: process.platform,
});
process.stdout.write(`OpenBot folder: ${root}\n${doctorReport(findings)}\n`);
process.exit(findings.some((finding) => finding.level === "error") ? 1 : 0);
