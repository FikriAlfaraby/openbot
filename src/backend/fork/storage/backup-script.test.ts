import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../../../scripts/fork/openbot-backup");
const available = (command: string) => spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const runnable = process.platform === "linux" && available("tar") && (available("python3") || available("sqlite3"));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openbot-backup-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function server() {
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "OpenBot", "Partitions", "a", "Cache"), { recursive: true });
  mkdirSync(join(home, "OpenBot", "Agents", "coder"), { recursive: true });
  mkdirSync(join(root, "srv", "keyrings"), { recursive: true });
  writeFileSync(join(home, "OpenBot", "Agents", "coder", "notes.md"), "notes");
  writeFileSync(join(home, ".config", "OpenBot", "Partitions", "a", "Cache", "blob"), "cache");
  writeFileSync(join(root, "srv", "keyrings", "login.keyring"), "key");
  const db = new DatabaseSync(join(home, ".config", "OpenBot", "openbot.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('kept');");
  return { home, db };
}

function run(env: Record<string, string>) {
  return spawnSync("bash", [SCRIPT, "run"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OPENBOT_BACKUP_CONFIG: join(root, "none.env"),
      OPENBOT_BACKUP_HOME: join(root, "home"),
      OPENBOT_BACKUP_KEYRING: join(root, "srv"),
      OPENBOT_BACKUP_DIR: join(root, "out"),
      ...env,
    },
  });
}

describe.skipIf(!runnable)("openbot-backup", () => {
  it("writes one archive with a database copy, the home folder and the keyring, without caches", () => {
    const { db } = server();
    const result = run({});
    db.close();
    expect(result.status, result.stderr).toBe(0);
    const [archive] = readdirSync(join(root, "out"));
    expect(archive).toMatch(/^openbot-\d{8}T\d{6}Z\.tar\.gz$/u);
    const names = execFileSync("tar", ["-tzf", join(root, "out", archive ?? "")], { encoding: "utf8" }).split("\n");
    expect(names).toContain("databases/.config/OpenBot/openbot.db");
    expect(names).toContain("home/OpenBot/Agents/coder/notes.md");
    expect(names).toContain("keyring/keyrings/login.keyring");
    expect(names).toContain("MANIFEST");
    expect(names.some((name) => name.includes("Cache/blob"))).toBe(false);
    expect(names).not.toContain("home/.config/OpenBot/openbot.db");
    mkdirSync(join(root, "restore"));
    execFileSync("tar", ["-xzf", join(root, "out", archive ?? ""), "-C", join(root, "restore")]);
    const copy = new DatabaseSync(join(root, "restore", "databases", ".config", "OpenBot", "openbot.db"));
    expect(copy.prepare("SELECT x FROM t").all()).toEqual([{ x: "kept" }]);
    copy.close();
  });

  it("refuses to send an unencrypted archive to a bucket", () => {
    server().db.close();
    const result = run({ OPENBOT_BACKUP_BUCKET: "gs://bucket/openbot" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not sent to gs://bucket/openbot unencrypted");
  });

  it("refuses a keep count that is not a whole number", () => {
    server().db.close();
    expect(run({ OPENBOT_BACKUP_KEEP: "0" }).status).toBe(1);
  });
});
