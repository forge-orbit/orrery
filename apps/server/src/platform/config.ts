import { z } from "zod";

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    DATABASE_URL: z.url(),

    PUBLIC_URL: z.url().default("http://localhost:8080"),

    BOOTSTRAP_SECRET: z
      .string()
      .optional()
      .transform((value) => (value !== undefined && value.trim() === "" ? undefined : value))
      .refine((value) => value === undefined || value.length >= 32, {
        message: "BOOTSTRAP_SECRET must be at least 32 characters. Generate a long random secret.",
      }),

    ORRERY_ENCRYPTION_KEY: z
      .string()
      .optional()
      .transform((value) => (value !== undefined && value.trim() === "" ? undefined : value))
      .refine((value) => value === undefined || isCanonicalBase64Key(value), {
        message:
          "ORRERY_ENCRYPTION_KEY must be base64 for exactly 32 bytes. Generate one with: openssl rand -base64 32",
      })
      .transform((value) => (value === undefined ? undefined : Buffer.from(value, "base64"))),

    // Default-deny SSRF guard: webhook delivery requires https:// and public IPs unless
    // an operator explicitly opts in to internal LAN receivers (which also permits http://).
    ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    // Object storage is deployment-only configuration (ADR-0008): switching backends
    // live would strand blobs, so drivers are selected here rather than in settings.
    ORRERY_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    ORRERY_DATA_DIR: z.string().min(1).default("data"),

    // S3-compatible backend (RustFS, MinIO, Garage, AWS S3, Cloudflare R2, ...).
    // Required only when ORRERY_STORAGE_DRIVER=s3; see the refinement below.
    ORRERY_S3_ENDPOINT: z.string().optional(),
    ORRERY_S3_BUCKET: z.string().optional(),
    // Compose passes an empty string for unset variables, so treat blank as absent.
    ORRERY_S3_REGION: z
      .string()
      .optional()
      .transform((value) => (value?.trim() ? value.trim() : "us-east-1")),
    ORRERY_S3_ACCESS_KEY_ID: z.string().optional(),
    ORRERY_S3_SECRET_ACCESS_KEY: z.string().optional(),
    ORRERY_S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    WEB_DIST: z.string().optional(),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.ORRERY_STORAGE_DRIVER !== "s3") return;
    const required = [
      "ORRERY_S3_ENDPOINT",
      "ORRERY_S3_BUCKET",
      "ORRERY_S3_ACCESS_KEY_ID",
      "ORRERY_S3_SECRET_ACCESS_KEY",
    ] as const;
    for (const name of required) {
      if (!env[name]?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required when ORRERY_STORAGE_DRIVER=s3`,
        });
      }
    }
    if (env.ORRERY_S3_ENDPOINT?.trim()) {
      let endpoint: URL | null = null;
      try {
        endpoint = new URL(env.ORRERY_S3_ENDPOINT);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["ORRERY_S3_ENDPOINT"],
          message: "ORRERY_S3_ENDPOINT must be a URL (for example http://rustfs:9000)",
        });
      }
      const httpProtocol =
        endpoint !== null && (endpoint.protocol === "http:" || endpoint.protocol === "https:");
      if (endpoint !== null && (!httpProtocol || endpoint.hostname === "")) {
        ctx.addIssue({
          code: "custom",
          path: ["ORRERY_S3_ENDPOINT"],
          message: "ORRERY_S3_ENDPOINT must be an http(s) URL (for example http://rustfs:9000)",
        });
      }
    }
  });

export type Config = z.infer<typeof Env>;

function isCanonicalBase64Key(value: string): boolean {
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
