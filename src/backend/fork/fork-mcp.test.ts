import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORK_CONFIG_FILE_NAME, parseForkConfig } from "./fork-config";
import { forkMcpNames, withForkMcp } from "./fork-mcp";
import { forkMcpServersFor } from "./router-policy";

const servers = [{ name: "t3" }, { name: "github" }, { name: "computer-use" }];

describe("forkMcpNames and withForkMcp", () => {
  it("keeps all servers when the param is absent", () => {
    expect(forkMcpNames({ cwd: "/x" })).toBeNull();
    expect(withForkMcp(servers, null)).toEqual(servers);
  });

  it("keeps only the allowed names, and none for an empty list", () => {
    expect(withForkMcp(servers, forkMcpNames({ forkMcpServers: ["github", 7] }))).toEqual([{ name: "github" }]);
    expect(withForkMcp(servers, forkMcpNames({ forkMcpServers: [] }))).toEqual([]);
  });
});

describe("mcp limits in fork-config.yaml", () => {
  let root: string;
  let shared: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openbot-fork-mcp-"));
    shared = join(root, "Shared");
    mkdirSync(shared);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("parses the agents of each server", () => {
    const parsed = parseForkConfig("version: 1\nmcp:\n  t3:\n    agents: [coder]\n");
    expect(parsed.ok && [...(parsed.config.mcpAgents.get("t3") ?? [])]).toEqual(["coder"]);
    expect(parseForkConfig("version: 1\nmcp:\n  t3:\n    agents: [coder]\n    role: x\n").ok).toBe(false);
  });

  it("gives a limited server only to the agents it names, and other servers to all", () => {
    expect(forkMcpServersFor(shared, "researcher", servers)).toEqual(servers);
    const path = join(root, FORK_CONFIG_FILE_NAME);
    writeFileSync(path, "version: 1\nmcp:\n  t3:\n    agents: [coder]\n");
    utimesSync(path, 1_950_000_000, 1_950_000_000);
    expect(forkMcpServersFor(shared, "coder", servers).map((server) => server.name)).toEqual([
      "t3",
      "github",
      "computer-use",
    ]);
    expect(forkMcpServersFor(shared, "researcher", servers).map((server) => server.name)).toEqual([
      "github",
      "computer-use",
    ]);
  });
});
