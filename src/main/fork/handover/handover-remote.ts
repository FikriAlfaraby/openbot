// Fork module (docs/fork/travel-handover.md). The joined servers as travel handover reads them: their
// list, its calls, and the first copy of an agent, made with the instance transfer that Settings uses
// (profile, memories, skills and routines, without files or server settings).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRemoteInstanceTransferResult } from "@openbot/contracts/ipc";
import { INSTANCE_TRANSFER_ROUTES } from "@openbot/contracts/team-protocol/instance-transfer-v1";
import { runCauseEffect } from "../../../backend/effect-boundary";
import type { InstanceTransferService } from "../../instance-transfer-service";
import { AGENT_IMPORT_UPLOAD_TIMEOUT_MS, type RemoteServerManager } from "../../remote-server-manager";
import type { HandoverRemote } from "./handover-sync";

export function handoverRemote(
  remoteServers: Pick<RemoteServerManager, "list" | "request" | "stageInstanceTransfer">,
  instanceTransfer: Pick<InstanceTransferService, "exportTo">,
): HandoverRemote {
  return {
    servers: () => remoteServers.list(),
    call: (serverId, path, body) =>
      runCauseEffect(remoteServers.request(serverId, path, (value: unknown) => value, { method: "POST", body })),
    copyAgent: async (serverId, agentId) => {
      const folder = await mkdtemp(join(tmpdir(), "openbot-handover-"));
      try {
        const path = join(folder, "agent.zip");
        await runCauseEffect(
          instanceTransfer.exportTo(path, { agentIds: [agentId], includeFiles: false, includeSettings: false }),
        );
        const preview = await runCauseEffect(
          remoteServers.stageInstanceTransfer(serverId, new Uint8Array(await readFile(path))),
        );
        const key = preview.agents[0]?.key;
        if (!key) throw new Error("The transfer file has no agent.");
        const result = await runCauseEffect(
          remoteServers.request(serverId, INSTANCE_TRANSFER_ROUTES.apply, decodeRemoteInstanceTransferResult, {
            method: "POST",
            body: {
              token: preview.token,
              keys: [key],
              includeSettings: false,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            timeoutMs: AGENT_IMPORT_UPLOAD_TIMEOUT_MS,
          }),
        );
        const copy = result.agents[0]?.agentId;
        if (!copy) throw new Error(result.skipped[0]?.reason ?? "The server made no copy of the agent.");
        return copy;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
