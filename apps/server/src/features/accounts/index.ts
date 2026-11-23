import type { Feature } from "../../platform/feature.ts";
import type { AccountsService } from "./service.ts";
import { createAccountsRest, createSessionReader, routes, type SessionReader } from "./rest.ts";
import { type AccountsDeps, createAccountsService } from "./service.ts";

export { routes as accountsRoutes };
export { createAccountsService, startupWarnings } from "./service.ts";
export {
  accountByEmail,
  hashPassword,
  invalidateAccountSessions,
  setAccountPasswordHash,
} from "./service.ts";
export type { AccountsService, SessionPolicy, SessionAccount } from "./service.ts";
export { createSessionReader, toSessionResponse, type SessionReader } from "./rest.ts";

export interface AccountsFeature extends Feature {
  sessionReader: SessionReader;
  markEmailVerified: AccountsService["markEmailVerified"];
  createInvitedHuman: AccountsService["createInvitedHuman"];
  emailRegistered: AccountsService["emailRegistered"];
  accountByEmail: AccountsService["accountByEmail"];
  hashPassword: AccountsService["hashPassword"];
  setPasswordHash: AccountsService["setPasswordHash"];
  invalidateBrowserSessions: AccountsService["invalidateBrowserSessions"];
}

export function createAccountsFeature(deps: AccountsDeps): AccountsFeature {
  const service = createAccountsService(deps);
  return {
    name: "accounts",
    rest: createAccountsRest(service),
    sessionReader: createSessionReader(service),
    markEmailVerified: (humanId, tx) => service.markEmailVerified(humanId, tx),
    createInvitedHuman: (input, tx) => service.createInvitedHuman(input, tx),
    emailRegistered: (email, tx) => service.emailRegistered(email, tx),
    accountByEmail: (email, tx) => service.accountByEmail(email, tx),
    hashPassword: (password) => service.hashPassword(password),
    setPasswordHash: (humanId, passwordHash, tx) =>
      service.setPasswordHash(humanId, passwordHash, tx),
    invalidateBrowserSessions: (humanId, tx) => service.invalidateBrowserSessions(humanId, tx),
  };
}
