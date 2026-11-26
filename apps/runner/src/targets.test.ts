import { describe, expect, it } from "vitest";
import type { RunnerTargetsResponse } from "@orrery/contract";
import { isUuidLike, resolveAgent, resolveProject, resolveWorkspace } from "./targets.ts";

const targets: RunnerTargetsResponse = {
  workspaces: [
    {
      id: "ws-acme",
      name: "Acme",
      slug: "acme",
      kind: "shared",
      projects: [
        { id: "proj-one", key: "ONE", name: "One", accessLevel: "manage" },
        { id: "proj-two", key: "TWO", name: "Two", accessLevel: "contribute" },
        { id: "proj-dup", key: "DUP", name: "Shared", accessLevel: "manage" },
      ],
    },
    {
      id: "ws-other",
      name: "Other",
      slug: "other",
      kind: "personal",
      projects: [
        { id: "proj-three", key: "THREE", name: "Three", accessLevel: "manage" },
        { id: "proj-dup-2", key: "D4", name: "Shared", accessLevel: "manage" },
      ],
    },
    {
      id: "ws-empty",
      name: "Empty",
      slug: "empty",
      kind: "shared",
      projects: [],
    },
  ],
  agents: [
    { id: "agent-ada", name: "Ada" },
    { id: "agent-bo", name: "Bo" },
  ],
  defaultAgentId: "agent-ada",
};

describe("target resolvers (#267)", () => {
  it("detects UUID-shaped values for server-side passthrough", () => {
    expect(isUuidLike("12345678-1234-1234-1234-1234567890ab")).toBe(true);
    expect(isUuidLike("12345678-1234-1234-1234-1234567890AB")).toBe(true);
    expect(isUuidLike("workspace-1")).toBe(false);
    expect(isUuidLike("Acme")).toBe(false);
    expect(isUuidLike("")).toBe(false);
  });

  it("resolves workspaces by exact ID, name, then slug", () => {
    expect(resolveWorkspace(targets, "ws-acme").name).toBe("Acme");
    expect(resolveWorkspace(targets, "Acme").id).toBe("ws-acme");
    expect(resolveWorkspace(targets, "acme").id).toBe("ws-acme");
    expect(resolveWorkspace(targets, "ACME").id).toBe("ws-acme");
  });

  it("prefers exact name over a case-insensitive slug collision", () => {
    const tricky: RunnerTargetsResponse = {
      ...targets,
      workspaces: [
        { id: "a", name: "ACME", slug: "other", kind: "shared", projects: [] },
        { id: "b", name: "Other", slug: "acme", kind: "shared", projects: [] },
      ],
    };
    // Exact name wins before slug matching runs.
    expect(resolveWorkspace(tricky, "ACME").id).toBe("a");
    expect(resolveWorkspace(tricky, "acme").id).toBe("b");
  });

  it("fails workspace lookup listing only the caller's own candidates", () => {
    expect(() => resolveWorkspace(targets, "missing")).toThrow(
      /No workspace matches 'missing'.*'Acme' \(ws-acme\).*'Other' \(ws-other\)/,
    );
  });

  it("fails duplicate exact workspace names with an ambiguity listing IDs", () => {
    const tricky: RunnerTargetsResponse = {
      ...targets,
      workspaces: [
        { id: "a", name: "Acme", slug: "a-slug", kind: "shared", projects: [] },
        { id: "b", name: "Acme", slug: "b-slug", kind: "shared", projects: [] },
      ],
    };
    expect(() => resolveWorkspace(tricky, "Acme")).toThrow(/ambiguous.*'Acme' \(a\).*'Acme' \(b\)/);
  });

  it("fails duplicate exact workspace slugs with an ambiguity listing IDs", () => {
    const tricky: RunnerTargetsResponse = {
      ...targets,
      workspaces: [
        { id: "a", name: "Alpha", slug: "shared", kind: "shared", projects: [] },
        { id: "b", name: "Beta", slug: "shared", kind: "shared", projects: [] },
      ],
    };
    expect(() => resolveWorkspace(tricky, "shared")).toThrow(
      /ambiguous.*'Alpha' \(a\).*'Beta' \(b\)/,
    );
  });
  it("fails ambiguously on case-insensitive workspace collisions", () => {
    const tricky: RunnerTargetsResponse = {
      ...targets,
      workspaces: [
        { id: "a", name: "Acme", slug: "", kind: "shared", projects: [] },
        { id: "b", name: "ACME", slug: "", kind: "shared", projects: [] },
      ],
    };
    expect(() => resolveWorkspace(tricky, "acme")).toThrow(/ambiguous.*'Acme' \(a\).*'ACME' \(b\)/);
  });

  it("ignores empty slugs when slug-matching", () => {
    const tricky: RunnerTargetsResponse = {
      ...targets,
      workspaces: [{ id: "a", name: "Q", slug: "", kind: "shared", projects: [] }],
    };
    expect(() => resolveWorkspace(tricky, "")).toThrow(/No workspace matches/);
  });

  it("resolves projects by exact ID, case-insensitive key, then unique exact name", () => {
    const acme = targets.workspaces[0]!;
    expect(resolveProject(targets, "proj-one", acme).projectKey).toBe("ONE");
    expect(resolveProject(targets, "one", acme).projectId).toBe("proj-one");
    expect(resolveProject(targets, "Two", acme).projectId).toBe("proj-two");
    // Global resolution without a scope finds the project and its workspace.
    const hit = resolveProject(targets, "THREE", undefined);
    expect(hit.projectId).toBe("proj-three");
    expect(hit.workspace.id).toBe("ws-other");
  });

  it("fails ambiguous cross-workspace project names without guessing", () => {
    expect(() => resolveProject(targets, "Shared", undefined)).toThrow(
      /ambiguous.*'Shared' \(DUP, proj-dup\) in workspace 'Acme'.*'Shared' \(D4, proj-dup-2\) in workspace 'Other'/s,
    );
  });

  it("reports empty workspaces explicitly instead of missing", () => {
    const empty = targets.workspaces[2]!;
    expect(() => resolveProject(targets, "anything", empty)).toThrow(
      /Workspace 'Empty' has no projects you can contribute to/,
    );
  });

  it("lists scoped candidates on a scoped miss", () => {
    const acme = targets.workspaces[0]!;
    expect(() => resolveProject(targets, "nope", acme)).toThrow(
      /No project matches 'nope' in workspace 'Acme'/,
    );
  });

  it("resolves agents by UUID passthrough, exact name, then unique case-insensitive name", () => {
    const uuid = "12345678-1234-1234-1234-1234567890ab";
    expect(resolveAgent(targets, uuid)).toBe(uuid);
    expect(resolveAgent(targets, "Ada")).toBe("agent-ada");
    expect(resolveAgent(targets, "bo")).toBe("agent-bo");
    expect(resolveAgent(targets, undefined)).toBe("agent-ada");
  });

  it("fails agent lookup with the caller's own candidates", () => {
    expect(() => resolveAgent(targets, "Zed")).toThrow(
      /No agent matches 'Zed'.*'Ada' \(agent-ada\).*'Bo' \(agent-bo\)/,
    );
    const tricky: RunnerTargetsResponse = {
      ...targets,
      agents: [
        { id: "a1", name: "Sam" },
        { id: "a2", name: "SAM" },
      ],
    };
    expect(() => resolveAgent(tricky, "sam")).toThrow(/ambiguous/);
    expect(() => resolveAgent({ workspaces: [], agents: [], defaultAgentId: null }, "Sam")).toThrow(
      /has no agents/,
    );
  });
});
