import { z } from "zod";
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
    super(`Orrery returned ${status}${code === null ? "" : ` (${code})`}: ${message}`);
    this.name = "RunnerRequestError";
    this.status = status;
    this.code = code;
  }
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
    this.server = options.server.replace(/\/$/, "");
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
        headers,
        signal: this.signal ?? null,
      });
    } catch (error) {
      throw new Error(`Cannot reach Orrery at ${this.server}: ${String(error)}`, { cause: error });
    }
    if (!response.ok) {
      let code: string | null = null;
      let detail: string = response.statusText;
      try {
        const body = z
          .object({
            code: z.string().optional(),
            detail: z.string().optional(),
            title: z.string().optional(),
          })
          .safeParse(await response.json());
        if (body.success) {
          if (body.data.code !== undefined) code = body.data.code;
          if (body.data.detail !== undefined) detail = body.data.detail;
          else if (body.data.title !== undefined) detail = body.data.title;
        }
      } catch {
        // A non-JSON failure still becomes a typed status error.
      }
      throw new RunnerRequestError(response.status, code, detail);
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
