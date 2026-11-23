import { Email, NewPassword } from "@orrery/contract";
import {
  accountByEmail,
  hashPassword,
  invalidateAccountSessions,
  setAccountPasswordHash,
} from "./features/accounts/index.ts";
import { createRecoveryService, RecoveryError } from "./features/recovery/index.ts";
import { loadConfig } from "./platform/config.ts";
import { createDb } from "./platform/db.ts";
import { errorSummary } from "./platform/errors.ts";
import { createLogger } from "./platform/log.ts";

const usage =
  "Usage: set ORRERY_RECOVERY_EMAIL and ORRERY_RECOVERY_PASSWORD, then run " +
  "node apps/server/src/recovery-cli.ts with the server's environment.";

const emailInput = process.env.ORRERY_RECOVERY_EMAIL;
const passwordInput = process.env.ORRERY_RECOVERY_PASSWORD;
if (emailInput === undefined || passwordInput === undefined) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const email = Email.safeParse(emailInput);
const password = NewPassword.safeParse(passwordInput);
if (!email.success || !password.success) {
  process.stderr.write("The recovery email or password is invalid.\n");
  process.exit(2);
}

const config = loadConfig();
const database = createDb(config.DATABASE_URL);
const log = createLogger(config.LOG_LEVEL);
const recovery = createRecoveryService({
  db: database.db,
  accounts: {
    accountByEmail: (address, tx) => accountByEmail(tx ?? database.db, address),
    hashPassword: (value) => hashPassword(value),
    setPasswordHash: (humanId, passwordHash, tx) =>
      setAccountPasswordHash(tx, humanId, passwordHash),
    invalidateBrowserSessions: (humanId, tx) => invalidateAccountSessions(tx, humanId),
  },

  deliver: async () => {
    throw new Error("local recovery never sends mail");
  },
  publicUrl: config.PUBLIC_URL,
  log,
});

try {
  const result = await recovery.localRecover(email.data, password.data);

  process.stdout.write(`Password recovered for ${result.email}.\n`);
} catch (error) {
  log.error("local recovery failed", { ...errorSummary(error) });
  process.stderr.write(
    error instanceof RecoveryError ? `${error.message}\n` : "Local recovery failed.\n",
  );
  process.exitCode = 1;
} finally {
  await database.sql.end();
}
