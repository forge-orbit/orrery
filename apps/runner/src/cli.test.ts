import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";

const deviceRequestBody = z.object({ verifierHash: z.string(), hostDisplayName: z.string() });
const tokenRequestBody = z.object({ deviceCode: z.string(), verifier: z.string() });
const registrationBody = z.object({
  repoFingerprint: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
});

const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const directories: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function makeDir() {
  const path = await mkdtemp(join(tmpdir(), "orrery-runner-test-"));
  directories.push(path);
  return path;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function bodyOf(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("orrery-runner CLI against a real HTTP control plane stub", () => {
  it("logs in with a verifier-bound exchange and stores the credential with 0600 permissions", async () => {
    const dir = await makeDir();
    let verifierHash = "";
    let requestedHostName = "";
    let usedVerifier = "";
    let exchanges = 0;
    const stub = await listen(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/runners/device-codes") {
        const body = deviceRequestBody.parse(await bodyOf(req));
        verifierHash = body.verifierHash;
        requestedHostName = body.hostDisplayName;
        json(res, 201, {
          deviceCode: "orr_dc_test-device-code-1234567890",
          userCode: "ABCD-2345",
          verificationUri: "http://orrery.test/device?code=ABCD-2345",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/device-codes/token") {
        const body = tokenRequestBody.parse(await bodyOf(req));
        exchanges += 1;
        if (exchanges === 1) {
          json(res, 409, { status: 409, code: "device_code_pending", title: "Pending" });
          return;
        }
        usedVerifier = body.verifier;
        json(res, 200, {
          hostId: "host-1",
          credential: "orr_rh_local-credential-1234567890",
          displayName: "TestLaptop",
          platform: "linux-x64",
        });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "Not found" });
    });

    try {
      const result = await run(
        [
          "login",
          "--server",
          stub.url,
          "--host-name",
          "TestLaptop",
          "--platform",
          "linux-x64",
          "--poll-ms",
          "30",
        ],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("User code: ABCD-2345");
      expect(requestedHostName).toBe("TestLaptop");
      expect(sha256(usedVerifier)).toBe(verifierHash);
      expect(exchanges).toBe(2);

      const path = join(dir, "runner-credential.json");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const stored = z
        .object({ credential: z.string(), hostId: z.string() })
        .parse(JSON.parse(await readFile(path, "utf8")));
      expect(stored.credential).toBe("orr_rh_local-credential-1234567890");
      expect(stored.hostId).toBe("host-1");
    } finally {
      await stub.close();
    }
  });

  it("registers with an opaque fingerprint and stops immediately on a 401 heartbeat", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "runner-credential.json"),
      JSON.stringify({
        server: "http://orrery.test",
        hostId: "host-1",
        credential: "orr_rh_local-credential-1234567890",
        displayName: "TestLaptop",
        platform: "linux-x64",
      }),
      { mode: 0o600 },
    );
    let registration: z.infer<typeof registrationBody> | undefined;
    let heartbeats = 0;
    const stub = await listen(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/runners/register") {
        registration = registrationBody.parse(await bodyOf(req));
        json(res, 201, {
          id: "runner-1",
          hostId: "host-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          agentId: "agent-1",
          displayName: "TestLaptop",
          repoFingerprint: registration.repoFingerprint,
          capabilities: [],
          maxConcurrency: 1,
          activeSlotCount: 0,
          lastSeenAt: new Date().toISOString(),
          disconnectedAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
          presence: "online",
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-1/heartbeat") {
        heartbeats += 1;
        json(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "Not found" });
    });

    try {
      const started = Date.now();
      const result = await run(
        [
          "start",
          "--server",
          stub.url,
          "--workspace",
          "workspace-1",
          "--project",
          "project-1",
          "--heartbeat-ms",
          "50",
        ],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.stdout).toContain("401");
      expect(heartbeats).toBe(1);
      expect(registration?.workspaceId).toBe("workspace-1");
      expect(registration?.projectId).toBe("project-1");
      expect(registration?.repoFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(registration)).not.toContain("orrery-runner-test-");
    } finally {
      await stub.close();
    }
  });

  it("stops the heartbeat loop on a runner_revoked 401 after workspace member removal", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "runner-credential.json"),
      JSON.stringify({
        server: "http://orrery.test",
        hostId: "host-1",
        credential: "orr_rh_local-credential-1234567890",
        displayName: "TestLaptop",
        platform: "linux-x64",
      }),
      { mode: 0o600 },
    );
    let heartbeats = 0;
    const stub = await listen(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/runners/register") {
        json(res, 201, {
          id: "runner-2",
          hostId: "host-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          agentId: "agent-1",
          displayName: "TestLaptop",
          repoFingerprint: sha256("checkout"),
          capabilities: [],
          maxConcurrency: 1,
          activeSlotCount: 0,
          lastSeenAt: new Date().toISOString(),
          disconnectedAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
          presence: "online",
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-2/heartbeat") {
        heartbeats += 1;
        if (heartbeats === 1) {
          json(res, 200, {
            id: "runner-2",
            hostId: "host-1",
            workspaceId: "workspace-1",
            projectId: "project-1",
            agentId: "agent-1",
            displayName: "TestLaptop",
            repoFingerprint: sha256("checkout"),
            capabilities: [],
            maxConcurrency: 1,
            activeSlotCount: 0,
            lastSeenAt: new Date().toISOString(),
            disconnectedAt: null,
            revokedAt: null,
            createdAt: new Date().toISOString(),
            presence: "online",
          });
          return;
        }
        json(res, 401, {
          status: 401,
          code: "runner_revoked",
          title: "This Runner was revoked or lost workspace access. Stop local operation.",
        });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "Not found" });
    });

    try {
      const result = await run(
        [
          "start",
          "--server",
          stub.url,
          "--workspace",
          "workspace-1",
          "--project",
          "project-1",
          "--heartbeat-ms",
          "50",
        ],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("401");
      expect(result.stdout).toContain("Stopping local operation immediately");
      expect(heartbeats).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("acknowledges commands whose seq starts above 1 after a runner restart", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "runner-credential.json"),
      JSON.stringify({
        server: "http://orrery.test",
        hostId: "host-1",
        credential: "orr_rh_local-credential-1234567890",
        displayName: "TestLaptop",
        platform: "linux-x64",
      }),
      { mode: 0o600 },
    );
    const acked: number[] = [];
    let pollCount = 0;
    const stub = await listen(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/runners/register") {
        json(res, 201, {
          id: "runner-restart",
          hostId: "host-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          agentId: "agent-1",
          displayName: "TestLaptop",
          repoFingerprint: sha256("checkout"),
          capabilities: [],
          maxConcurrency: 1,
          activeSlotCount: 0,
          lastSeenAt: new Date().toISOString(),
          disconnectedAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
          presence: "online",
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-restart/reconnect") {
        json(res, 200, { resolutions: [] });
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/runners/runner-restart/commands")) {
        pollCount += 1;
        const url = new URL(req.url, "http://127.0.0.1");
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
        if (afterSeq < 6) {
          json(res, 200, {
            commands: [
              {
                commandId: "cmd-6",
                runnerId: "runner-restart",
                seq: 6,
                dispatchId: "disp-6",
                dispatchAttemptId: "att-6",
                kind: "cancel",
                payload: {
                  dispatchId: "disp-6",
                  dispatchAttemptId: "att-6",
                  issueId: "issue-6",
                  reason: "stale",
                },
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            ],
          });
          return;
        }
        // Once seq 6 is acked, revoke so the runner exits cleanly.
        json(res, 401, { status: 401, code: "runner_revoked", title: "Revoked" });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-restart/commands/ack") {
        const body = z.object({ upToSeq: z.number() }).parse(await bodyOf(req));
        acked.push(body.upToSeq);
        json(res, 200, { ackedSeq: body.upToSeq });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-restart/heartbeat") {
        json(res, 200, {
          id: "runner-restart",
          hostId: "host-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          agentId: "agent-1",
          displayName: "TestLaptop",
          repoFingerprint: sha256("checkout"),
          capabilities: [],
          maxConcurrency: 1,
          activeSlotCount: 0,
          lastSeenAt: new Date().toISOString(),
          disconnectedAt: null,
          revokedAt: null,
          createdAt: new Date().toISOString(),
          presence: "online",
        });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "Not found" });
    });

    try {
      const result = await run(
        [
          "start",
          "--server",
          stub.url,
          "--workspace",
          "workspace-1",
          "--project",
          "project-1",
          "--heartbeat-ms",
          "5000",
        ],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(acked).toEqual([6]);
      expect(pollCount).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("refuses to start without a host credential", async () => {
    const dir = await makeDir();
    const result = await run(
      ["start", "--server", "http://127.0.0.1:1", "--workspace", "w", "--project", "p"],
      { ORRERY_RUNNER_CONFIG_DIR: dir },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("login");
  });
});
