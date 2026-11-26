import { describe, expect, it } from "vitest";
import type { RunnerTargetsResponse } from "@orrery/contract";
import { RunnerRequestError } from "./client.ts";
import type { RepoBinding } from "./repos.ts";
import { mapRegistrationError, resolveTargets, type TargetClient } from "./resolution.ts";

const targets: RunnerTargetsResponse = {
  workspaces: [
    {
      id: "ws-acme",
      name: "Acme",
      slug: "acme",
      kind: "shared",
      projects: [
        { id: "proj-one", key: "ONE", name: "One", accessLevel: "manage" },
        { id: "proj-two", key: "TWO", name: "Two", accessLevel: "manage" },
      ],
    },
    {
      id: "ws-other",
      name: "Other",
      slug: "other",
      kind: "shared",
      projects: [
        { id: "proj-three", key: "THREE", name: "Three", accessLevel: "manage" },
        { id: "proj-shared", key: "S1", name: "Shared", accessLevel: "manage" },
      ],
    },
    {
      id: "ws-second",
      name: "Second",
      slug: "second",
      kind: "shared",
      projects: [{ id: "proj-shared-2", key: "S2", name: "Shared", accessLevel: "manage" }],
    },
  ],
  agents: [
    { id: "agent-ada", name: "Ada" },
    { id: "agent-bo", name: "Bo" },
  ],
  defaultAgentId: "agent-ada",
};

const saved: RepoBinding = {
  server: "http://127.0.0.1:8080",
  bindingFingerprint: "a".repeat(64),
  workspaceId: "ws-acme",
  projectId: "proj-one",
  agentId: "agent-ada",
  hostId: "host-1",
  workspaceName: "Acme",
  projectKey: "ONE",
  agentName: "Ada",
  updatedAt: new Date(0).toISOString(),
};

function fakeClient(
  response: RunnerTargetsResponse | Error,
  calls: { count: number },
): TargetClient {
  return {
    server: "http://127.0.0.1:8080",
    async getTargets() {
      calls.count += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

interface Base {
  flags?: { workspace?: string; project?: string; agent?: string };
  binding?: RepoBinding | undefined;
  alwaysSave?: boolean;
  isTTY?: boolean;
}

async function resolve(
  calls: { count: number },
  response: RunnerTargetsResponse | Error,
  base: Base = {},
) {
  const lines: string[] = [];
  const resolved = await resolveTargets({
    client: fakeClient(response, calls),
    flags: base.flags ?? {},
    binding: base.binding,
    bindingFingerprint: "a".repeat(64),
    storedHostId: "host-1",
    write: (line) => lines.push(line),
    choose: async () => null,
    isTTY: base.isTTY ?? false,
    alwaysSave: base.alwaysSave ?? false,
  });
  return { resolved, lines };
}

describe("target resolution precedence (#267)", () => {
  it("uses a saved binding with zero network when no flags are given", async () => {
    const calls = { count: 0 };
    const { resolved } = await resolve(calls, targets, { binding: saved });
    expect(calls.count).toBe(0);
    expect(resolved.targetsFetched).toBe(false);
    expect(resolved.workspaceId).toBe("ws-acme");
    expect(resolved.projectId).toBe("proj-one");
    expect(resolved.agentId).toBe("agent-ada");
    expect(resolved.bindingToSave).toBeNull();
  });

  it("skips targets for fully explicit UUIDs and schedules a fresh save", async () => {
    const calls = { count: 0 };
    const ws = "11111111-1111-1111-1111-111111111111";
    const pr = "22222222-2222-2222-2222-222222222222";
    const { resolved } = await resolve(calls, targets, {
      flags: { workspace: ws, project: pr },
    });
    expect(calls.count).toBe(0);
    expect(resolved.workspaceId).toBe(ws);
    expect(resolved.projectId).toBe(pr);
    expect(resolved.agentId).toBeUndefined();
    expect(resolved.bindingToSave).toMatchObject({ workspaceId: ws, projectId: pr });
  });

  it("resolves human-readable flags against targets", async () => {
    const calls = { count: 0 };
    const { resolved } = await resolve(calls, targets, {
      flags: { workspace: "Acme", project: "TWO", agent: "Bo" },
    });
    expect(calls.count).toBe(1);
    expect(resolved.workspaceId).toBe("ws-acme");
    expect(resolved.projectId).toBe("proj-two");
    expect(resolved.projectKey).toBe("TWO");
    expect(resolved.agentId).toBe("agent-bo");
    expect(resolved.agentName).toBe("Bo");
  });

  it("overrides a saved binding for one run without scheduling a write", async () => {
    const calls = { count: 0 };
    const { resolved } = await resolve(calls, targets, {
      binding: saved,
      flags: { project: "TWO" },
    });
    expect(resolved.workspaceId).toBe("ws-acme");
    expect(resolved.projectId).toBe("proj-two");
    expect(resolved.bindingToSave).toBeNull();
    expect(resolved.notices.join("\n")).toContain("left unchanged");
  });

  it("refuses a lone --project outside the bound workspace instead of switching", async () => {
    const calls = { count: 0 };
    await expect(
      resolve(calls, targets, { binding: saved, flags: { project: "THREE" } }),
    ).rejects.toThrow(/in workspace 'Acme'.*--reconfigure.*left unchanged/s);
    expect(calls.count).toBe(1);
  });

  it("checks a lone --workspace against the bound project symmetrically", async () => {
    const calls = { count: 0 };
    await expect(
      resolve(calls, targets, { binding: saved, flags: { workspace: "Other" } }),
    ).rejects.toThrow(/not in workspace 'Other'.*left unchanged/s);
  });

  it("resolves a lone --project globally and fails on ambiguity", async () => {
    const calls = { count: 0 };
    const { resolved } = await resolve(calls, targets, { flags: { project: "THREE" } });
    expect(resolved.workspaceId).toBe("ws-other");
    expect(resolved.projectId).toBe("proj-three");
    await expect(resolve({ count: 0 }, targets, { flags: { project: "Shared" } })).rejects.toThrow(
      /ambiguous/,
    );
  });

  it("fails fast in non-TTY when a full picker would be required", async () => {
    const calls = { count: 0 };
    await expect(resolve(calls, targets, { isTTY: false })).rejects.toThrow(
      /non-interactive.*--workspace.*--project.*init/s,
    );
    expect(calls.count).toBe(0);
  });

  it("fails fast in non-TTY when only --workspace is given without a binding", async () => {
    const calls = { count: 0 };
    await expect(
      resolve(calls, targets, { flags: { workspace: "Acme" }, isTTY: false }),
    ).rejects.toThrow(/non-interactive.*--workspace.*--project.*init/s);
    expect(calls.count).toBe(1);
  });

  it("maps 401 and capped 409 discovery failures to remediation", async () => {
    const bad401 = { count: 0 };
    await expect(
      resolve(bad401, new RunnerRequestError(401, "invalid_credential", "Revoked"), {
        flags: { workspace: "Acme", project: "ONE" },
      }),
    ).rejects.toThrow(/login/);
    const capped = { count: 0 };
    await expect(
      resolve(capped, new RunnerRequestError(409, "targets_too_large", "Too many"), {
        flags: { workspace: "Acme", project: "ONE" },
      }),
    ).rejects.toThrow(/explicit UUIDs/);
  });

  it("reports a saved workspace that is no longer visible as stale", async () => {
    const calls = { count: 0 };
    const gone = { ...saved, workspaceId: "ws-gone" };
    await expect(
      resolve(calls, targets, { binding: gone, flags: { project: "ONE" } }),
    ).rejects.toThrow(/no longer accessible.*--reconfigure.*left unchanged/s);
  });

  it("prints a notice when the host enrollment changed but keeps the binding", async () => {
    const calls = { count: 0 };
    const lines: string[] = [];
    const resolved = await resolveTargets({
      client: fakeClient(targets, calls),
      flags: {},
      binding: saved,
      bindingFingerprint: "a".repeat(64),
      storedHostId: "host-2",
      write: (line) => lines.push(line),
      isTTY: false,
      alwaysSave: false,
    });
    expect(calls.count).toBe(0);
    expect(resolved.workspaceId).toBe("ws-acme");
    expect(lines.join("\n")).toContain("different Runner host enrollment");
  });

  it("passes agent UUIDs through and resolves agent names", async () => {
    const uuid = "33333333-3333-3333-3333-333333333333";
    const direct = { count: 0 };
    const passthrough = await resolve(direct, targets, { binding: saved, flags: { agent: uuid } });
    expect(direct.count).toBe(0);
    expect(passthrough.resolved.agentId).toBe(uuid);
    const named = { count: 0 };
    const byName = await resolve(named, targets, { binding: saved, flags: { agent: "Bo" } });
    expect(named.count).toBe(1);
    expect(byName.resolved.agentId).toBe("agent-bo");
  });

  it("uses the response default agent when neither flags nor binding set one", async () => {
    const calls = { count: 0 };
    const { resolved } = await resolve(calls, targets, { flags: { project: "THREE" } });
    expect(resolved.agentId).toBe("agent-ada");
  });
});

describe("stale registration mapping (#267)", () => {
  const ids = { workspaceId: "ws-acme", projectId: "proj-one" };
  it("maps 401 to re-login", () => {
    expect(
      mapRegistrationError(new RunnerRequestError(401, "invalid_credential", "x"), ids).message,
    ).toMatch(/login.*left unchanged/s);
  });
  it("maps workspace_not_found distinctly", () => {
    expect(
      mapRegistrationError(new RunnerRequestError(404, "workspace_not_found", "x"), ids).message,
    ).toContain("no longer accessible");
  });
  it("maps project_not_found with the 30-day Trash window", () => {
    const message = mapRegistrationError(
      new RunnerRequestError(404, "project_not_found", "x"),
      ids,
    ).message;
    expect(message).toContain("Trash");
    expect(message).toContain("30 days");
  });
  it("maps agent_not_found distinctly", () => {
    expect(
      mapRegistrationError(new RunnerRequestError(404, "agent_not_found", "x"), ids).message,
    ).toContain("no longer available");
  });
  it("maps no_default_agent to agent creation", () => {
    expect(
      mapRegistrationError(new RunnerRequestError(409, "no_default_agent", "x"), ids).message,
    ).toContain("no agent to run as");
  });
  it("passes through unrecognized errors", () => {
    const boom = new RunnerRequestError(500, "boom", "Boom");
    expect(mapRegistrationError(boom, ids)).toBe(boom);
  });
});
