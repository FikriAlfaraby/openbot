import { type ConversationMessage, isConversationMessage } from "@openbot/contracts/ipc";
import { TRAVEL_HANDOVER_ROUTES } from "@openbot/contracts/team-protocol/fork-travel-handover-v1";
import type { HandoverServer } from "../fork/handover/handover-server";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, stringField } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(TRAVEL_HANDOVER_ROUTES));

/**
 * Fork: travel handover (docs/fork/travel-handover.md). Only an owner or an admin: the calls write
 * into an agent's chat and read it. `readJson` has already run each body through the wire codec.
 */
export async function routeForkHandover(
  context: TeamApiRequestContext,
  handover: HandoverServer | null,
): Promise<RouteOutcome> {
  const { method, url, member, request, json } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname) || !handover) return "unmatched";
  requireAdmin(member);
  const body = await readJson(request);
  const source = {
    sourceServerId: stringField(body, "sourceServerId"),
    sourceAgentId: url.pathname === TRAVEL_HANDOVER_ROUTES.status ? "" : stringField(body, "sourceAgentId"),
  };
  switch (url.pathname) {
    case TRAVEL_HANDOVER_ROUTES.register:
      return json(200, handover.register({ ...source, agentId: stringField(body, "agentId") }));
    case TRAVEL_HANDOVER_ROUTES.push:
      return json(200, handover.push({ ...source, messages: messagesOf(body.messages) }));
    case TRAVEL_HANDOVER_ROUTES.status:
      return json(
        200,
        handover.status({
          sourceServerId: source.sourceServerId,
          agentIds: Array.isArray(body.agentIds) ? body.agentIds.filter((id) => typeof id === "string") : [],
        }),
      );
    case TRAVEL_HANDOVER_ROUTES.pull:
      return json(200, handover.pull({ ...source, after: typeof body.after === "number" ? body.after : 0 }));
    default:
      return json(200, await handover.release(source));
  }
}

/** The codec checked each message already; this gives the list its type. */
function messagesOf(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || !value.every(isConversationMessage))
    throw new HttpError(400, "A list of messages is required.");
  return value.filter(isConversationMessage);
}
