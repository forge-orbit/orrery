import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const baseEnv = { DATABASE_URL: "postgres://orrery:pw@localhost:5432/orrery" };

describe("loadConfig: BOOTSTRAP_SECRET", () => {
  it("treats an unset, empty, or blank secret as not configured", () => {
    expect(loadConfig({ ...baseEnv }).BOOTSTRAP_SECRET).toBeUndefined();
    expect(loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: "" }).BOOTSTRAP_SECRET).toBeUndefined();
    expect(loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: "   " }).BOOTSTRAP_SECRET).toBeUndefined();
  });

  it("refuses to start with a configured secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: "a".repeat(31) })).toThrow(
      /BOOTSTRAP_SECRET/,
    );
  });

  it("accepts a secret of at least 32 characters", () => {
    const secret = "a".repeat(32);
    expect(loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: secret }).BOOTSTRAP_SECRET).toBe(secret);
  });
});

describe("loadConfig: object storage", () => {
  it("defaults to the local driver under a data directory", () => {
    const config = loadConfig(baseEnv);
    expect(config.ORRERY_STORAGE_DRIVER).toBe("local");
    expect(config.ORRERY_DATA_DIR).toBe("data");
  });

  it("reads the data directory and rejects a blank one", () => {
    expect(loadConfig({ ...baseEnv, ORRERY_DATA_DIR: "/srv/orrery" }).ORRERY_DATA_DIR).toBe(
      "/srv/orrery",
    );
    expect(() => loadConfig({ ...baseEnv, ORRERY_DATA_DIR: "" })).toThrow(/ORRERY_DATA_DIR/);
  });

  it("refuses an unknown storage driver", () => {
    expect(() => loadConfig({ ...baseEnv, ORRERY_STORAGE_DRIVER: "gcs" })).toThrow(
      /ORRERY_STORAGE_DRIVER/,
    );
  });

  it("defaults the attachment size cap to 25 MB and accepts a configured byte count", () => {
    expect(loadConfig(baseEnv).ORRERY_MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(
      loadConfig({ ...baseEnv, ORRERY_MAX_ATTACHMENT_BYTES: "1048576" })
        .ORRERY_MAX_ATTACHMENT_BYTES,
    ).toBe(1024 * 1024);
    expect(() => loadConfig({ ...baseEnv, ORRERY_MAX_ATTACHMENT_BYTES: "0" })).toThrow(
      /ORRERY_MAX_ATTACHMENT_BYTES/,
    );
  });

  const s3Env = {
    ...baseEnv,
    ORRERY_STORAGE_DRIVER: "s3" as const,
    ORRERY_S3_ENDPOINT: "http://rustfs:9000",
    ORRERY_S3_BUCKET: "orrery",
    ORRERY_S3_ACCESS_KEY_ID: "access",
    ORRERY_S3_SECRET_ACCESS_KEY: "secret",
  };

  it("accepts a complete S3 configuration", () => {
    const config = loadConfig(s3Env);
    expect(config.ORRERY_STORAGE_DRIVER).toBe("s3");
    expect(config.ORRERY_S3_BUCKET).toBe("orrery");
    expect(config.ORRERY_S3_REGION).toBe("us-east-1");
    expect(config.ORRERY_S3_FORCE_PATH_STYLE).toBe(false);
  });

  it("parses force path style and a custom region", () => {
    const config = loadConfig({
      ...s3Env,
      ORRERY_S3_REGION: "eu-central-1",
      ORRERY_S3_FORCE_PATH_STYLE: "true",
    });
    expect(config.ORRERY_S3_REGION).toBe("eu-central-1");
    expect(config.ORRERY_S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("treats the empty strings Compose passes for unset S3 variables as defaults", () => {
    const config = loadConfig({ ...s3Env, ORRERY_S3_REGION: "" });
    expect(config.ORRERY_S3_REGION).toBe("us-east-1");
  });

  it("fails fast when a required S3 variable is missing or blank", () => {
    for (const name of [
      "ORRERY_S3_ENDPOINT",
      "ORRERY_S3_BUCKET",
      "ORRERY_S3_ACCESS_KEY_ID",
      "ORRERY_S3_SECRET_ACCESS_KEY",
    ] as const) {
      expect(() => loadConfig({ ...s3Env, [name]: "" })).toThrow(new RegExp(name));
    }
    // This is what Compose passes when none of the S3 variables are set in .env.
    expect(() =>
      loadConfig({
        ...baseEnv,
        ORRERY_STORAGE_DRIVER: "s3",
        ORRERY_S3_ENDPOINT: "",
        ORRERY_S3_BUCKET: "",
        ORRERY_S3_REGION: "",
        ORRERY_S3_ACCESS_KEY_ID: "",
        ORRERY_S3_SECRET_ACCESS_KEY: "",
        ORRERY_S3_FORCE_PATH_STYLE: "false",
      }),
    ).toThrow(/ORRERY_S3_ENDPOINT/);
  });

  it("rejects a malformed S3 endpoint", () => {
    expect(() => loadConfig({ ...s3Env, ORRERY_S3_ENDPOINT: "rustfs:9000" })).toThrow(
      /ORRERY_S3_ENDPOINT/,
    );
  });
});

describe("loadConfig: ORRERY_ENCRYPTION_KEY", () => {
  it("treats an unset, empty, or blank key as no key", () => {
    expect(loadConfig({ ...baseEnv }).ORRERY_ENCRYPTION_KEY).toBeUndefined();
    expect(
      loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "" }).ORRERY_ENCRYPTION_KEY,
    ).toBeUndefined();
    expect(
      loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "   " }).ORRERY_ENCRYPTION_KEY,
    ).toBeUndefined();
  });

  it("decodes a 32-byte base64 key to the 32 bytes", () => {
    const key = loadConfig({
      ...baseEnv,

      ORRERY_ENCRYPTION_KEY: "dGhpcy1rZXktaXMtanVzdC1hLXRlc3QtZml4dHVyZSE=",
    }).ORRERY_ENCRYPTION_KEY;
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.byteLength).toBe(32);
  });

  it("refuses to start with a key that is not base64 for exactly 32 bytes", () => {
    expect(() => loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "aGk=" })).toThrow(
      /ORRERY_ENCRYPTION_KEY/,
    );

    expect(() =>
      loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/ORRERY_ENCRYPTION_KEY/);

    expect(() => loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "not base64!!" })).toThrow(
      /ORRERY_ENCRYPTION_KEY/,
    );
  });

  it("refuses a stray character inside an otherwise valid key", () => {
    const valid = "5JxZLMqonzkGHjJwLLuzM6d6fQ6m7onmSI+7yeB9NW0=";
    const stray = `${valid.slice(0, 22)}*${valid.slice(22)}`;
    expect(() => loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: stray })).toThrow(
      /ORRERY_ENCRYPTION_KEY/,
    );
  });
});
