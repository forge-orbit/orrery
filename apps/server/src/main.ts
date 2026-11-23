import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { startupWarnings as accountWarnings } from "./features/accounts/index.ts";
import { createFeatures } from "./features/index.ts";
import { startupWarnings as settingsWarnings } from "./features/settings/index.ts";
import { loadConfig } from "./platform/config.ts";
import { createDb } from "./platform/db.ts";
import { createApp } from "./platform/http.ts";
import { createLogger } from "./platform/log.ts";
import { migrate } from "./platform/migrate.ts";
import { startObjectSweeps } from "./platform/object-sweep.ts";
import { createObjectStore } from "./platform/storage.ts";
import { version } from "./platform/version.ts";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const database = createDb(config.DATABASE_URL);

const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const applied = await migrate(database.sql, migrationsDir);
if (applied.length > 0) log.info("migrations applied", { applied });

for (const warning of [
  ...(await accountWarnings({ db: database.db, setupSecret: config.BOOTSTRAP_SECRET })),
  ...(await settingsWarnings({ db: database.db, encryptionKey: config.ORRERY_ENCRYPTION_KEY })),
]) {
  log.warn(warning);
}

const storage = createObjectStore(config);
const storageHealth = await storage.checkHealth();
if (!storageHealth.ok) {
  log.error("object storage is not ready", { reason: storageHealth.reason });
  process.exit(1);
}

const features = createFeatures(database, config, log, storage);

// One shared claim-first sweep reclaims blobs for every stored_objects consumer.
startObjectSweeps(database.db, storage, log);
for (const feature of features) feature.startBackgroundTasks?.();

const app = createApp({
  features,
  publicUrl: config.PUBLIC_URL,
  webDist: config.WEB_DIST,
  log,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log.info("orrery listening", { port: info.port, version, publicUrl: config.PUBLIC_URL });
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await database.sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
