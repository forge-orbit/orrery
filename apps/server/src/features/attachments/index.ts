import type { Feature } from "../../platform/feature.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createAttachmentsRest, routes } from "./rest.ts";
import {
  createAttachmentsService,
  type AttachmentsDeps,
  type AttachmentsService,
} from "./service.ts";

export { routes as attachmentsRoutes };
export { AttachmentsError, MAX_INLINE_IMAGE_BYTES, isInlineContentType } from "./service.ts";
export { attachmentHolderKey } from "./service.ts";
export type {
  AttachmentsService,
  AttachmentHolder,
  AttachmentMetadataByHolder,
  ServedAttachment,
  SyncReferencesInput,
} from "./service.ts";

export type AttachmentsFeatureDeps = AttachmentsDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
  log?: Logger;
};

/** The seams projects uses to keep references in step with saved Markdown. */
export interface AttachmentSeams {
  syncReferences: AttachmentsService["syncReferences"];
  listMetadata: AttachmentsService["listMetadata"];
  purgeHolders: AttachmentsService["purgeHolders"];
  purgeProjectAttachments: AttachmentsService["purgeProjectAttachments"];
}

export interface AttachmentsFeature extends Feature {
  service: AttachmentsService;
  startBackgroundTasks(): void;
}

export function createAttachmentsFeature(deps: AttachmentsFeatureDeps): AttachmentsFeature {
  const service = createAttachmentsService(deps);
  return {
    name: "attachments",
    rest: createAttachmentsRest(service, deps.sessionReader, deps.authenticate),
    service,
    startBackgroundTasks: () => {
      let sweeping = false;
      const timer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void service
          .sweepUnreferenced()
          .catch((error: unknown) => {
            deps.log?.warn("unreferenced attachment sweep failed", { error: String(error) });
          })
          .finally(() => {
            sweeping = false;
          });
      }, 60 * 1000);
      timer.unref();
    },
  };
}
