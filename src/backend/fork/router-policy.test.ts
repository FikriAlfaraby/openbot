import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { developerInstructions } from "../agent/developer-instructions";
import { BUILTIN_TOOL_CATALOG } from "../agent/tool-catalog";
import { FORK_CONFIG_FILE_NAME } from "./fork-config";
import {
  filterDiscoveryForRouter,
  forkRoleOf,
  ROUTER_CLAUDE_DISALLOWED_TOOLS,
  ROUTER_OPENBOT_TOOLS,
  ROUTER_ROLE_RULE,
  routerMayUse,
  routerRefusal,
} from "./router-policy";

describe("routerMayUse", () => {
  it("allows routing, talking and memory tools", () => {
    for (const tool of ["send_message", "list_agents", "ask_user", "remember", "search_memories", "tool_search"])
      expect(routerMayUse("openbot", tool)).toBe(true);
    expect(routerMayUse("openbot", "ticket_create")).toBe(true);
  });

  it("refuses the tools of work", () => {
    for (const tool of [
      "create_routine",
      "publish_site",
      "html_render",
      "capture_screen",
      "create_agent",
      "update_agents",
    ])
      expect(routerMayUse("openbot", tool)).toBe(false);
    expect(routerMayUse("openbot_browser", "navigate")).toBe(false);
    expect(routerMayUse("openbot_browser", "send_message")).toBe(false);
  });

  it("names only tools that exist in the catalog, apart from the bridge, history and wait tools", () => {
    const catalog = new Set(BUILTIN_TOOL_CATALOG.map((entry) => entry.name));
    const outside = [...ROUTER_OPENBOT_TOOLS].filter((name) => !catalog.has(name));
    for (const name of outside)
      expect(
        ["tool_search", "tool_describe", "tool_call", "history_search", "history_read", "await_event"].some(
          (tool) => name === `openbot.${tool}`,
        ) ||
          name.startsWith("openbot.search_") ||
          name.startsWith("openbot.routine_") ||
          name.startsWith("openbot.forget_") ||
          name.startsWith("openbot.ask_ui"),
        name,
      ).toBe(true);
  });

  it("tells the model what to do instead", () => {
    expect(routerRefusal("openbot_browser", "navigate")).toContain("openbot.send_message");
  });

  it("takes shell, file and web tools from Claude", () => {
    for (const tool of ["Bash", "Read", "Write", "Edit", "WebFetch", "Task"])
      expect(ROUTER_CLAUDE_DISALLOWED_TOOLS).toContain(tool);
  });
});

describe("filterDiscoveryForRouter", () => {
  it("keeps only the tools that the Router may call", () => {
    const result = filterDiscoveryForRouter({
      tools: [{ name: "openbot.send_message" }, { name: "openbot_browser.navigate" }, { name: "openbot.publish_site" }],
      guidance: ["x"],
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(["openbot.send_message"]);
    expect(result.guidance).toEqual(["x"]);
  });
});

describe("forkRoleOf", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openbot-router-policy-"));
    mkdirSync(join(root, "Shared"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads the role from fork-config.yaml beside the shared directory", () => {
    const sharedRoot = join(root, "Shared");
    expect(forkRoleOf(sharedRoot, "orchestrator")).toBeNull();
    const path = join(root, FORK_CONFIG_FILE_NAME);
    writeFileSync(path, "version: 1\nagents:\n  orchestrator:\n    role: router\n");
    utimesSync(path, 1_900_000_000, 1_900_000_000);
    expect(forkRoleOf(sharedRoot, "orchestrator")).toBe("router");
    expect(forkRoleOf(sharedRoot, "coder")).toBeNull();
  });
});

describe("Router developer instructions", () => {
  const agent = {
    id: "orchestrator",
    provider: "claude",
    name: "Router",
    title: "Router",
    description: "",
    notifications: true,
    model: "claude",
    reasoningEffort: "medium",
    threadId: "openbot-thread-orchestrator",
    workspacePath: "/tmp/openbot-router",
    preview: "",
    updatedAt: "2026-11-02T10:00:00.000Z",
    avatarSeed: "router",
    avatarHue: null,
    avatarUrl: null,
  } satisfies AgentSummary;

  it("adds the host rule only for the Router", () => {
    const build = (router: boolean) =>
      developerInstructions(agent, "/tmp/shared", [], "/tmp/auto", DEFAULT_AGENT_DEFAULTS, { router });
    expect(build(true)).toContain(ROUTER_ROLE_RULE);
    expect(build(false)).not.toContain(ROUTER_ROLE_RULE);
    expect(build(true).indexOf(ROUTER_ROLE_RULE)).toBeGreaterThan(build(true).indexOf("</agent_profile>"));
  });
});
