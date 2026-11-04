import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORK_CONFIG_FILE_NAME, FORK_CONFIG_MAX_BYTES, ForkConfigReader, parseForkConfig } from "./fork-config";

const VALID = `version: 1
agents:
  orchestrator-7f3a:
    role: router
  coder_01:
    role: worker
  watch:
    role: watchdog
`;

describe("parseForkConfig", () => {
  it("reads the role of each agent", () => {
    const parsed = parseForkConfig(VALID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.roles.get("orchestrator-7f3a")).toBe("router");
      expect(parsed.config.roles.get("coder_01")).toBe("worker");
      expect(parsed.config.roles.get("watch")).toBe("watchdog");
    }
  });

  it("treats an empty file as no roles", () => {
    expect(parseForkConfig("# nothing yet\n")).toMatchObject({ ok: true });
  });

  it("refuses an unknown role, field, version or agent id", () => {
    expect(parseForkConfig("version: 1\nagents:\n  a:\n    role: admin\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\nagents:\n  a:\n    role: worker\n    access: full\n").ok).toBe(false);
    expect(parseForkConfig("version: 2\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\nrole: router\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\nagents:\n  ../x:\n    role: worker\n").ok).toBe(false);
  });

  it("refuses two routers, duplicate keys and aliases", () => {
    const two = parseForkConfig("version: 1\nagents:\n  a:\n    role: router\n  b:\n    role: router\n");
    expect(two).toEqual({ ok: false, issue: "Only one agent can have the role router." });
    expect(parseForkConfig("version: 1\nagents:\n  a:\n    role: worker\n  a:\n    role: router\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\nx: &r router\nagents:\n  a:\n    role: *r\n").ok).toBe(false);
  });

  it("names the field, not the value, in an issue", () => {
    const parsed = parseForkConfig("version: 1\nagents:\n  a:\n    role: secret-value-123\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issue).toContain("role");
  });

  it("reads the travel handover server and its agents", () => {
    const all = parseForkConfig("version: 1\nhandover:\n  server: fikri-cloud\n");
    expect(all).toMatchObject({
      ok: true,
      config: { handover: { server: "fikri-cloud", agents: null, everyMinutes: null } },
    });
    const some = parseForkConfig(
      "version: 1\nhandover:\n  server: fikri-cloud\n  agents: [a1, b2]\n  everyMinutes: 5\n",
    );
    expect(some).toMatchObject({ ok: true, config: { handover: { agents: ["a1", "b2"], everyMinutes: 5 } } });
    expect(parseForkConfig("version: 1\nhandover:\n  agents: [a1]\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\nhandover:\n  server: x\n  everyMinutes: 0\n").ok).toBe(false);
    expect(parseForkConfig("version: 1\n")).toMatchObject({ ok: true, config: { handover: null } });
  });
});

describe("ForkConfigReader", () => {
  let root: string;
  let path: string;
  let tick = 1_800_000_000;
  /** Writes the file with a new modification time, so the reader sees a change. */
  const write = (text: string) => {
    writeFileSync(path, text);
    tick += 10;
    utimesSync(path, tick, tick);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openbot-fork-config-"));
    path = join(root, FORK_CONFIG_FILE_NAME);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("gives no roles without a file", () => {
    const reader = new ForkConfigReader(root);
    expect(reader.roleOf("orchestrator-7f3a")).toBeNull();
    expect(reader.current().issue).toBeNull();
  });

  it("reads a change of the file", () => {
    const reader = new ForkConfigReader(root);
    write(VALID);
    expect(reader.roleOf("coder_01")).toBe("worker");
    write("version: 1\nagents:\n  coder_01:\n    role: watchdog\n");
    expect(reader.roleOf("coder_01")).toBe("watchdog");
  });

  it("keeps the last valid roles when an edit is not valid", () => {
    const reader = new ForkConfigReader(root);
    write(VALID);
    expect(reader.roleOf("orchestrator-7f3a")).toBe("router");
    write("version: 1\nagents: [\n");
    expect(reader.roleOf("orchestrator-7f3a")).toBe("router");
    expect(reader.current().issue).toContain("not valid");
    write(VALID);
    expect(reader.current().issue).toBeNull();
  });

  it("keeps the last valid roles for a file over the size limit", () => {
    const reader = new ForkConfigReader(root);
    write(VALID);
    reader.current();
    write(`${VALID}#${"x".repeat(FORK_CONFIG_MAX_BYTES)}\n`);
    expect(reader.roleOf("orchestrator-7f3a")).toBe("router");
    expect(reader.current().issue).toContain("larger than");
  });

  it("drops the roles when the owner removes the file", () => {
    const reader = new ForkConfigReader(root);
    write(VALID);
    expect(reader.roleOf("watch")).toBe("watchdog");
    rmSync(path);
    expect(reader.roleOf("watch")).toBeNull();
  });
});
