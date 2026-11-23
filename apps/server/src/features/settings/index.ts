import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createSettingsRest, routes } from "./rest.ts";
import { type SettingsDeps, createSettingsService, type OutgoingMail } from "./service.ts";

export { routes as settingsRoutes };
export { deliveryProblem } from "./rest.ts";
export type { SmtpMail, SmtpSender, SettingsService } from "./service.ts";
export { SettingsError, isDeliveryKind, startupWarnings } from "./service.ts";
export type { SettingsErrorKind, DeliveryErrorKind, OutgoingMail } from "./service.ts";
export { renderEmail, type EmailTemplate } from "./template.ts";

export type SettingsDepsWithAccounts = SettingsDeps & { sessionReader: SessionReader };

export interface SettingsFeature extends Feature {
  deliver: (mail: OutgoingMail) => Promise<void>;
}

export function createSettingsFeature(deps: SettingsDepsWithAccounts): SettingsFeature {
  const service = createSettingsService(deps);
  return {
    name: "settings",
    rest: createSettingsRest(service, deps.sessionReader),
    deliver: (mail) => service.deliver(mail),
  };
}
