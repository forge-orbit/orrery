import { z } from "zod";
import { assertSecureOrigin, canonicalizeServerUrl } from "./origin.ts";
import {
  AckCommandsResponse,
  AutoClaimResponse,
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
  HostCredentialResponse,
  IssueResolveResponse,
  ReconnectResponse,
  Runner,
  RunnerCommandsResponse,
  RunnerOfflineResponse,
  RunnerTargetsResponse,
  type AckCommandsRequest,
  type AutoClaimRequest,
  type CommandsQuery,
  type CreateDeviceCodeRequest,
  type ExchangeDeviceCodeRequest,
  type HarnessCatalog,
  type HeartbeatRequest,
  type IssueResolveRequest,
  type ReconnectRequest,
  type RegisterRunnerRequest,
  type RunnerDispatchRequest,
} from "@orrery/contract";

export class RunnerRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    const trimmed = message.trim();
    const prefix = `Orrery returned ${status}${code === null ? "" : ` (${code})`}`;
    super(trimmed === "" ? prefix : `${prefix}: ${trimmed}`);
    this.name = "RunnerRequestError";
    this.status = status;
    this.code = code;
  }
}

const ProblemBody = z.object({
  code: z.string().optional(),
  detail: z.string().optional(),
  title: z.string().optional(),
});

/** Parse an HTTP error response into a typed RunnerRequestError, preserving RFC 9457 Problem Details. */
export async function readRunnerRequestError(response: Response): Promise<RunnerRequestError> {
  let code: string | null = null;
  let detail: string = response.statusText.trim();
  const raw = (await response.text().catch(() => "")).trim();
  if (raw !== "") {
    let parsedJson = false;
    try {
      const parsed = ProblemBody.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) {
        parsedJson = true;
        if (parsed.data.code !== undefined) code = parsed.data.code;
        if (parsed.data.detail !== undefined) detail = parsed.data.detail;
        else if (parsed.data.title !== undefined) detail = parsed.data.title;
      }
    } catch {
      // Non-JSON proxy/gateway response (e.g. 502 HTML or plain text).
    }
    if (!parsedJson && detail === "" && !raw.startsWith("<")) {
      detail = raw.slice(0, 200);
    }
  }
  return new RunnerRequestError(response.status, code, detail);
}

export interface OrreryClientOptions {
  server: string;
  credential?: string | undefined;
  signal?: AbortSignal | undefined;
}

export class OrreryClient {
  readonly server: string;
  private readonly credential: string | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(options: OrreryClientOptions) {
    this.server = canonicalizeServerUrl(options.server);
    assertSecureOrigin(this.server);
    this.credential = options.credential;
    this.signal = options.signal;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.credential !== undefined) headers.set("authorization", `Bearer ${this.credential}`);
    let response: Response;
    try {
      response = await fetch(`${this.server}${path}`, {
        ...init,
        redirect: "error",
        headers,
        signal: this.signal ?? null,
      });
    } catch (error) {
      throw new Error(`Cannot reach Orrery at ${this.server}: ${String(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw await readRunnerRequestError(response);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  async createDeviceCode(input: CreateDeviceCodeRequest) {
    return DeviceCodeResponse.parse(
      await this.request("/api/runners/device-codes", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async exchangeDeviceCode(input: ExchangeDeviceCodeRequest) {
    return HostCredentialResponse.parse(
      await this.request("/api/runners/device-codes/token", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async registerRunner(input: RegisterRunnerRequest) {
    return Runner.parse(
      await this.request("/api/runners/register", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async heartbeat(runnerId: string, input: HeartbeatRequest) {
    return Runner.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/heartbeat`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  /** Publish the live Harness catalog; the server merges, never regresses. */
  async putCatalog(runnerId: string, input: HarnessCatalog) {
    return Runner.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/catalog`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    );
  }

  /** Poll the durable outbox; `waitMs > 0` uses long-poll with a periodic fallback. */
  async pollCommands(runnerId: string, query: Partial<CommandsQuery> = {}) {
    const params = new URLSearchParams();
    params.set("afterSeq", String(query.afterSeq ?? 0));
    if (query.waitMs !== undefined) params.set("waitMs", String(query.waitMs));
    return RunnerCommandsResponse.parse(
      await this.request(
        `/api/runners/${encodeURIComponent(runnerId)}/commands?${params.toString()}`,
      ),
    );
  }

  async ackCommands(runnerId: string, input: AckCommandsRequest) {
    return AckCommandsResponse.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/commands/ack`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async acceptDispatch(runnerId: string, dispatchId: string) {
    return DispatchAcceptance.parse(
      await this.request(
        `/api/runners/${encodeURIComponent(runnerId)}/dispatches/${encodeURIComponent(dispatchId)}/accept`,
        { method: "POST" },
      ),
    );
  }

  /** Startup/recovery reconciliation so live sessions stream into the Studio. */
  async reconnect(runnerId: string, input: ReconnectRequest) {
    return ReconnectResponse.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/reconnect`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async autoClaim(runnerId: string, input: AutoClaimRequest) {
    return AutoClaimResponse.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/auto-claim`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async createRunnerDispatch(runnerId: string, input: RunnerDispatchRequest) {
    return Dispatch.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/dispatches`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async resolveIssue(input: IssueResolveRequest) {
    return IssueResolveResponse.parse(
      await this.request("/api/runners/issue-resolve", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  /** Host-authenticated target discovery for human-readable flag resolution. */
  async getTargets() {
    return RunnerTargetsResponse.parse(await this.request("/api/runners/targets"));
  }

  async markRunnerOffline(runnerId: string) {
    return RunnerOfflineResponse.parse(
      await this.request(`/api/runners/${encodeURIComponent(runnerId)}/offline`, {
        method: "POST",
      }),
    );
  }

  /**
   * Renew the five-minute lease with a Dispatch token. The MCP `renew_claim`
   * tool is outside that token's allowlist in the current server contract, but
   * the equivalent REST route accepts it (ADR-0010's "REST equivalent").
   */
  async renewWorkSession(issueId: string, sessionId: string): Promise<void> {
    await this.request(`/api/issues/${encodeURIComponent(issueId)}/work-sessions/renew`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  }
}
