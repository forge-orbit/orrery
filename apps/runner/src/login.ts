import { createHash, randomBytes } from "node:crypto";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import { saveCredential, type StoredHostCredential } from "./credential.ts";
import { delay } from "./delay.ts";
import { validateDisplayName } from "./display-name.ts";
import { assertSecureOrigin, canonicalizeServerUrl } from "./origin.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface LoginOptions {
  server: string;
  hostDisplayName: string;
  platform?: string | undefined;
  pollIntervalMs?: number | undefined;
  signal?: AbortSignal | undefined;
  write?: ((line: string) => void) | undefined;
  save?: ((value: StoredHostCredential) => Promise<string>) | undefined;
}

/**
 * Runs the verifier-bound device-code flow, then stores the host credential
 * locally with 0600 permissions. No long-lived workspace API key is written.
 */
export async function login(options: LoginOptions): Promise<StoredHostCredential> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const server = canonicalizeServerUrl(options.server);
  assertSecureOrigin(server);
  const hostDisplayName = validateDisplayName(options.hostDisplayName);
  const verifier = randomBytes(32).toString("hex");
  const client = new OrreryClient({ server, signal: options.signal });

  const device = await client.createDeviceCode({
    hostDisplayName,
    platform,
    verifierHash: sha256(verifier),
  });
  write(`Approve this Runner host in your browser: ${device.verificationUri}`);
  write(`User code: ${device.userCode}`);

  const deadline = Date.parse(device.expiresAt);
  for (;;) {
    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      throw new Error(
        "The device code expired before it was approved. Run 'orrery-runner login' again.",
      );
    }
    await delay(options.pollIntervalMs ?? 2000, options.signal, "Login cancelled.");
    try {
      const exchanged = await client.exchangeDeviceCode({
        deviceCode: device.deviceCode,
        verifier,
      });
      const stored: StoredHostCredential = {
        server,
        hostId: exchanged.hostId,
        credential: exchanged.credential,
        displayName: exchanged.displayName,
        platform: exchanged.platform,
      };
      const path = await (options.save ?? saveCredential)(stored);
      write(`Runner host '${stored.displayName}' enrolled. Credential saved to ${path} (0600).`);
      return stored;
    } catch (error) {
      if (error instanceof RunnerRequestError && error.code === "device_code_pending") continue;
      if (error instanceof RunnerRequestError && error.status === 401) {
        throw new Error(
          "The host was deactivated during enrollment. Run 'orrery-runner login' again.",
          { cause: error },
        );
      }
      throw error;
    }
  }
}
