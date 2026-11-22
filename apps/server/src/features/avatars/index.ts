import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createAvatarsRest, routes } from "./rest.ts";
import { type AvatarsDeps, createAvatarsService } from "./service.ts";

export { routes as avatarsRoutes };
export { AvatarsError, avatarKey, MAX_AVATAR_BYTES } from "./service.ts";
export type { AvatarsService } from "./service.ts";

export function createAvatarsFeature(
  deps: AvatarsDeps & { sessionReader: SessionReader; authenticate: AgentAuthenticator },
): Feature {
  const service = createAvatarsService(deps);
  return {
    name: "avatars",
    rest: createAvatarsRest(service, deps.sessionReader, deps.authenticate),
  };
}
