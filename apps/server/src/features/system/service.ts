import type { Health } from "@orrery/contract";
import type { HealthResult } from "../../platform/storage.ts";
import { version } from "../../platform/version.ts";

export interface SystemDeps {
  ping: () => Promise<void>;
  checkStorage: () => Promise<HealthResult>;
}

export interface SystemService {
  health(): Health;
  ready(): Promise<Health>;
}

export function createSystemService({ ping, checkStorage }: SystemDeps): SystemService {
  return {
    health: () => ({ status: "ok", version }),
    async ready() {
      try {
        const [storage] = await Promise.all([checkStorage(), ping()]);
        return storage.ok ? { status: "ok", version } : { status: "degraded", version };
      } catch {
        return { status: "degraded", version };
      }
    },
  };
}
