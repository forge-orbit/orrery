import { describe, expect, it } from "vitest";
import type { RunnerTargetsResponse } from "@orrery/contract";
import {
  nonTTYError,
  pickProjectInWorkspace,
  pickTargets,
  pickerCancelledError,
  readlineChoose,
  type ChooseFn,
  type PickerOption,
} from "./picker.ts";

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
      projects: [{ id: "proj-three", key: "THREE", name: "Three", accessLevel: "manage" }],
    },
    {
      id: "ws-empty",
      name: "Empty",
      slug: "empty",
      kind: "shared",
      projects: [],
    },
  ],
  agents: [{ id: "agent-ada", name: "Ada" }],
  defaultAgentId: "agent-ada",
};

function scripted(values: Array<string | null>): { choose: ChooseFn; seen: string[] } {
  const seen: string[] = [];
  let index = 0;
  const choose: ChooseFn = async <T>(title: string, options: PickerOption<T>[]) => {
    seen.push(`${title}: ${options.map((option) => option.label).join(" | ")}`);
    const next = values[index++];
    if (next === null || next === undefined) return null;
    const hit = options.find((option) => option.label.includes(next));
    if (hit === undefined) throw new Error(`scripted picker has no option matching '${next}'`);
    return hit.value;
  };
  return { choose, seen };
}

const neverPrompt: ChooseFn = async () => {
  throw new Error("must not prompt in non-TTY");
};

describe("interactive picker (#267)", () => {
  it("auto-selects single-option levels with printed notes", async () => {
    const single: RunnerTargetsResponse = {
      workspaces: [
        {
          id: "ws-only",
          name: "Only",
          slug: "only",
          kind: "shared",
          projects: [{ id: "p-only", key: "O", name: "OnlyProject", accessLevel: "manage" }],
        },
      ],
      agents: [{ id: "agent-ada", name: "Ada" }],
      defaultAgentId: "agent-ada",
    };
    const lines: string[] = [];
    const { choose } = scripted([]);
    const picked = await pickTargets(single, {
      choose,
      isTTY: true,
      write: (line) => lines.push(line),
    });
    expect(picked.workspaceId).toBe("ws-only");
    expect(picked.projectId).toBe("p-only");
    expect(picked.agentId).toBe("agent-ada");
    expect(lines.join("\n")).toContain("Using workspace 'Only' (only available workspace).");
    expect(lines.join("\n")).toContain("Using project 'OnlyProject' (O; only available project).");
    expect(lines.join("\n")).toContain("Using default agent 'Ada'.");
  });

  it("filters empty workspaces unless all are empty", async () => {
    const { choose, seen } = scripted(["Other", "Three"]);
    const lines: string[] = [];
    const picked = await pickTargets(targets, {
      choose,
      isTTY: true,
      write: (line) => lines.push(line),
    });
    expect(picked.workspaceId).toBe("ws-other");
    expect(picked.projectId).toBe("proj-three");
    expect(seen[0]).not.toContain("Empty");
  });

  it("offers empty workspaces when every workspace is empty", async () => {
    const allEmpty: RunnerTargetsResponse = {
      workspaces: [{ id: "ws-empty", name: "Empty", slug: "empty", kind: "shared", projects: [] }],
      agents: [],
      defaultAgentId: null,
    };
    const { choose } = scripted(["Empty"]);
    const lines: string[] = [];
    await expect(
      pickTargets(allEmpty, { choose, isTTY: true, write: (line) => lines.push(line) }),
    ).rejects.toThrow(/Workspace 'Empty' has no projects you can contribute to/);
  });

  it("aborts cleanly on q without leaking handles", async () => {
    const { choose } = scripted([null]);
    await expect(pickTargets(targets, { choose, isTTY: true })).rejects.toThrow(
      pickerCancelledError().message,
    );
  });

  it("fails fast in non-TTY with exact CLI examples", async () => {
    await expect(pickTargets(targets, { choose: neverPrompt, isTTY: false })).rejects.toThrow(
      nonTTYError().message,
    );
    expect(nonTTYError().message).toContain("--workspace");
    expect(nonTTYError().message).toContain("--project");
    expect(nonTTYError().message).toContain("init");
  });

  it("picks a project inside an already-resolved workspace", async () => {
    const acme = targets.workspaces[0]!;
    const { choose } = scripted(["Two"]);
    const picked = await pickProjectInWorkspace(acme, targets, { choose, isTTY: true });
    expect(picked.workspaceId).toBe("ws-acme");
    expect(picked.projectId).toBe("proj-two");
    expect(picked.agentId).toBe("agent-ada");
  });

  it("reports empty scoped workspaces explicitly", async () => {
    const empty = targets.workspaces[2]!;
    const { choose } = scripted([]);
    await expect(pickProjectInWorkspace(empty, targets, { choose, isTTY: true })).rejects.toThrow(
      /Workspace 'Empty' has no projects you can contribute to/,
    );
  });

  it("continues without a default agent when the host has none", async () => {
    const none: RunnerTargetsResponse = {
      ...targets,
      agents: [],
      defaultAgentId: null,
    };
    const lines: string[] = [];
    const { choose } = scripted(["Acme", "One"]);
    const picked = await pickTargets(none, {
      choose,
      isTTY: true,
      write: (line) => lines.push(line),
    });
    expect(picked.agentId).toBeUndefined();
    expect(lines.join("\n")).toContain("no agents yet");
  });
});

describe("readlineChoose", () => {
  it("is a function (real TTY coverage is manual)", () => {
    expect(typeof readlineChoose).toBe("function");
  });
});
