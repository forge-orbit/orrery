import type { Feature } from "../../platform/feature.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createAvatarsRest, routes } from "./rest.ts";
import { type AvatarsDeps, createAvatarsService } from "./service.ts";

export { routes as avatarsRoutes };
export { AvatarsError, avatarKey, MAX_AVATAR_BYTES } from "./service.ts";
export type { AvatarsService } from "./service.ts";

export type AvatarsFeatureDeps = AvatarsDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
  log: Logger;
};

export interface AvatarsFeature extends Feature {
  sweepOrphans(): Promise<number>;
  startBackgroundTasks(): void;
}

export function createAvatarsFeature(deps: AvatarsFeatureDeps): AvatarsFeature {
  const service = createAvatarsService(deps);
  return {
    name: "avatars",
    rest: createAvatarsRest(service, deps.sessionReader, deps.authenticate),
    sweepOrphans: () => service.sweepOrphans(),
    startBackgroundTasks: () => {
      const timer = setInterval(() => {
        void service.sweepOrphans().catch((error: unknown) => {
          deps.log.warn("object storage orphan sweep failed", { error: String(error) });
        });
      }, 60 * 1000);
      timer.unref();
    },
  };
}
