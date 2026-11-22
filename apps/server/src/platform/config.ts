import { z } from "zod";

const Env = z.object({
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

  // Object storage is deployment-only configuration (ADR-0008). #170 adds `s3`.
  ORRERY_STORAGE_DRIVER: z.enum(["local"]).default("local"),
  ORRERY_DATA_DIR: z.string().min(1).default("data"),

  WEB_DIST: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
