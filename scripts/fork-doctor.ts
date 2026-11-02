// Fork tool (super-agent, roadmap item 5.3). Checks the fork setup of one OpenBot folder.
//
//   bun scripts/fork-doctor.ts [<OpenBot folder>]
//
// The folder holds Agents, Shared and fork-config.yaml: ~/OpenBot on a desktop,
// /var/lib/openbot/OpenBot on a self-hosted server (the default when it exists). Exits 1 when a
// check fails. It reads files only. On an installed server, `openbot doctor` runs the same check.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runForkDoctor } from "../src/backend/fork/doctor-node";

const SERVER_ROOT = "/var/lib/openbot/OpenBot";
const root = resolve(process.argv[2] ?? (existsSync(SERVER_ROOT) ? SERVER_ROOT : join(homedir(), "OpenBot")));
if (!existsSync(join(root, "Agents"))) {
  process.stderr.write(`${root} has no Agents folder. Usage: bun scripts/fork-doctor.ts [<OpenBot folder>]\n`);
  process.exit(2);
}
const { report, errors } = runForkDoctor(root);
process.stdout.write(`OpenBot folder: ${root}\n${report}\n`);
process.exit(errors > 0 ? 1 : 0);
