import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalizeServerUrl } from "./origin.ts";

export const StoredHostCredential = z
  .object({
    server: z.string(),
    hostId: z.string(),
    credential: z.string(),
    displayName: z.string(),
    platform: z.string(),
  })
  .meta({ id: "StoredHostCredential" });
export type StoredHostCredential = z.infer<typeof StoredHostCredential>;

export function configDirectory(): string {
  const override = process.env.ORRERY_RUNNER_CONFIG_DIR;
  return override !== undefined && override !== ""
    ? override
    : join(homedir(), ".config", "orrery");
}

export function credentialPath(): string {
  return join(configDirectory(), "runner-credential.json");
}

/** Stores the host credential with owner-only permissions. */
export async function saveCredential(value: StoredHostCredential): Promise<string> {
  const directory = configDirectory();
  const path = credentialPath();
  const canonical = { ...value, server: canonicalizeServerUrl(value.server) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(canonical, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode is masked by the process umask; enforce it explicitly.
  await chmod(path, 0o600);
  return path;
}

export async function readCredential(): Promise<StoredHostCredential> {
  const path = credentialPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("No Runner host credential is stored here. Run 'orrery-runner login' first.");
  }
  const parsed = StoredHostCredential.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error("The stored host credential is malformed. Run 'orrery-runner login' again.");
  }
  // Normalize legacy stored origins on read without silent rewrites: the file
  // keeps its bytes, but every caller sees the canonical origin.
  try {
    return { ...parsed.data, server: canonicalizeServerUrl(parsed.data.server) };
  } catch {
    throw new Error("The stored host credential is malformed. Run 'orrery-runner login' again.");
  }
}
