import { describe, expect, it } from "vitest";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { createSystemFeature } from "./index.ts";

function appWith(db: "up" | "down", storage: "up" | "down" = "up") {
  const ping = db === "up" ? async () => {} : async () => Promise.reject(new Error("db down"));
  const checkStorage =
    storage === "up"
      ? async () => ({ ok: true as const })
      : async () => ({ ok: false as const, reason: "object storage is not writable" });
  const log = createLogger("error");
  return createApp({
    features: [createSystemFeature({ ping, checkStorage })],
    publicUrl: "http://orrery.test",
    log,
  });
}

describe("health", () => {
  it("reports liveness", async () => {
    const res = await appWith("up").request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const res = await appWith("down").request("/readyz");
    expect(res.status).toBe(503);
  });

  it("returns 503 when object storage is unhealthy", async () => {
    const res = await appWith("up", "down").request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded" });
  });

  it("reports ready only when Postgres and storage are both healthy", async () => {
    const res = await appWith("up", "up").request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});
