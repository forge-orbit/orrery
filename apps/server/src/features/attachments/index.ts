import type { Feature } from "../../platform/feature.ts";
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
export type { AttachmentsService, ServedAttachment } from "./service.ts";

export type AttachmentsFeatureDeps = AttachmentsDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
};

export interface AttachmentsFeature extends Feature {
  service: AttachmentsService;
}

export function createAttachmentsFeature(deps: AttachmentsFeatureDeps): AttachmentsFeature {
  const service = createAttachmentsService(deps);
  return {
    name: "attachments",
    rest: createAttachmentsRest(service, deps.sessionReader, deps.authenticate),
    service,
  };
}
