import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type AgentAuthenticator, readBearerToken } from "./auth.ts";
import { createAgentsRest, routes } from "./rest.ts";
import { type AgentsDeps, type AgentsService, createAgentsService } from "./service.ts";

export { routes as agentsRoutes };
export {
  AgentsError,
  agentProjectAccessInTransaction,
  newDispatchToken,
  revokeMemberWorkspaceKeys,
} from "./service.ts";
export { agentErrorStatus, isAgentError, readBearerToken } from "./auth.ts";
export {
  assertDispatchBodyAllowed,
  assertDispatchRestAllowed,
  assertDispatchToolAllowed,
} from "./dispatch.ts";
export type { DispatchTarget } from "./dispatch.ts";
export type { AgentAuthenticator } from "./auth.ts";
export type { AgentsService, AgentsErrorKind } from "./service.ts";

export function createAgentAuthenticator(service: AgentsService): AgentAuthenticator {
  return async (request) => {
    const token = readBearerToken(request.headers.get("authorization"));
    return token === null ? null : service.authenticate(token);
  };
}

export interface AgentsFeature extends Feature {
  authenticator: AgentAuthenticator;
}

export function createAgentsFeature(
  deps: AgentsDeps & { sessionReader: SessionReader },
): AgentsFeature {
  const service = createAgentsService(deps);
  return {
    name: "agents",
    rest: createAgentsRest(service, deps.sessionReader),
    authenticator: createAgentAuthenticator(service),
  };
}
