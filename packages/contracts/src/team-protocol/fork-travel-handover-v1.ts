// Fork: the travel-handover wire contract (docs/fork/travel-handover.md). It is not advertised as a
// capability: the official clients never call it, and a server without it answers its routes with
// "not found", which the computer reads as "this server keeps no copies".
//
// What it grants: an owner or admin of a server, never a member, can make an agent of the server the
// copy of an agent on their computer, write that agent's chat messages into the copy, read the copy's
// owner, read the messages that a person wrote in the copy after taking it over, and give the chat back.
import { isConversationMessage } from "../ipc-conversation-messages";
import {
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
} from "./admin-wire";
import { decodeTeamProtocolV2Json } from "./v2";

export const TRAVEL_HANDOVER_ROUTES = {
  register: "/v1/fork/handover/register",
  push: "/v1/fork/handover/push",
  status: "/v1/fork/handover/status",
  pull: "/v1/fork/handover/pull",
  release: "/v1/fork/handover/release",
} as const;

// The statuses that say why a call was refused. A server without these routes answers 404.
/** A push to a copy that a person took over. */
export const TRAVEL_HANDOVER_TAKEN_OVER = 409;
/** A call for an agent that the server keeps no copy of, or whose copy is gone. */
export const TRAVEL_HANDOVER_NOT_REGISTERED = 410;
/** A release while the copy still answers. */
export const TRAVEL_HANDOVER_BUSY = 423;

/** The most messages of one push or pull. */
export const TRAVEL_HANDOVER_MESSAGES = 200;
/** The most agents of one status read. */
export const TRAVEL_HANDOVER_AGENTS = 200;

const message = (value: unknown) => {
  if (!isConversationMessage(value)) throw new Error("Invalid handover message.");
  return decodeTeamProtocolV2Json(value);
};
const owner = oneOf("source", "copy");
const source = { sourceServerId: identifier, sourceAgentId: identifier };
const messages = list(message, TRAVEL_HANDOVER_MESSAGES);

export const TRAVEL_HANDOVER_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [TRAVEL_HANDOVER_ROUTES.register, adminRoute(fields({ ...source, agentId: identifier }), fields({ owner }))],
  [
    TRAVEL_HANDOVER_ROUTES.push,
    adminRoute(fields({ ...source, messages }), fields({ owner, threadId: nullable(identifier) })),
  ],
  [
    TRAVEL_HANDOVER_ROUTES.status,
    adminRoute(
      fields({ sourceServerId: identifier, agentIds: list(identifier, TRAVEL_HANDOVER_AGENTS) }),
      fields({
        agents: list(
          fields({ sourceAgentId: identifier, agentId: identifier, owner, busy: boolean }),
          TRAVEL_HANDOVER_AGENTS,
        ),
      }),
    ),
  ],
  [
    TRAVEL_HANDOVER_ROUTES.pull,
    adminRoute(fields({ ...source, after: count }), fields({ messages, lastSequence: count, more: boolean })),
  ],
  [TRAVEL_HANDOVER_ROUTES.release, adminRoute(fields(source), fields({ owner }))],
]);
