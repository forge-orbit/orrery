import { createInterface } from "node:readline/promises";
import type { RunnerTargetsResponse } from "@orrery/contract";

/**
 * Zero-dependency numbered picker (`node:readline/promises`, #267) behind
 * an injectable `choose` seam so tests stay deterministic without a TTY.
 */

export interface PickerOption<T> {
  label: string;
  value: T;
}

/**
 * Present a numbered menu, resolving the chosen value. `null` means the
 * operator aborted (`q`, EOF, `Ctrl-C`/`Ctrl-D`). The default implementation
 * always closes its readline handle, even on abort.
 */
export type ChooseFn = <T>(title: string, options: PickerOption<T>[]) => Promise<T | null>;

export async function readlineChoose<T>(
  title: string,
  options: PickerOption<T>[],
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<T | null> {
  const rl = createInterface({ input: process.stdin, output: stdout });
  try {
    stdout.write(`${title}\n`);
    options.forEach((option, index) => stdout.write(`  ${index + 1}) ${option.label}\n`));
    for (;;) {
      let answer: string | null;
      try {
        answer = await rl.question(`Choose 1-${options.length} (or 'q' to quit): `);
      } catch {
        return null;
      }
      if (answer === null) return null;
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "" || trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
        return null;
      }
      const index = Number(trimmed);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        return options[index - 1]!.value;
      }
      stdout.write(`Enter a number from 1 to ${options.length}, or 'q' to quit.\n`);
    }
  } finally {
    rl.close();
  }
}

export interface PickerDeps {
  choose?: ChooseFn | undefined;
  isTTY?: boolean | undefined;
  write?: ((line: string) => void) | undefined;
}

export interface PickedTargets {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  /** The response default (first-created Agent), or undefined when the host has none. */
  agentId: string | undefined;
  agentName: string | undefined;
}

export const pickerCancelledError = (): Error =>
  new Error(
    "Target selection cancelled. Run again with explicit flags, " +
      "for example 'orrery-runner start --workspace <ID> --project <ID>'.",
  );

export const nonTTYError = (): Error =>
  new Error(
    "Cannot prompt for Workspace/Project in non-interactive mode. " +
      "Pass --workspace <ID|NAME|SLUG> and --project <KEY|NAME|ID> explicitly, " +
      "or save a binding first with 'orrery-runner init --workspace <ID> --project <ID>'.",
  );

/**
 * Project selection scoped to one already-resolved workspace (used when
 * `--workspace` was passed without `--project` and no binding applies).
 * A single project is auto-selected with a printed note.
 */
export async function pickProjectInWorkspace(
  workspace: RunnerTargetsResponse["workspaces"][number],
  targets: RunnerTargetsResponse,
  deps: PickerDeps = {},
): Promise<PickedTargets> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const isTTY = deps.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  const choose = deps.choose ?? readlineChoose;
  if (!isTTY) throw nonTTYError();
  if (workspace.projects.length === 0) {
    throw new Error(
      `Workspace '${workspace.name}' has no projects you can contribute to. ` +
        `Ask a workspace owner for Contribute access, or choose another workspace with --workspace.`,
    );
  }
  let project = workspace.projects[0]!;
  if (workspace.projects.length === 1) {
    write(`Using project '${project.name}' (${project.key}; only available project).`);
  } else {
    const chosen = await choose(
      `Select a project in workspace '${workspace.name}':`,
      workspace.projects.map((item) => ({ label: `${item.name} (${item.key})`, value: item })),
    );
    if (chosen === null || chosen === undefined) throw pickerCancelledError();
    project = chosen;
  }
  const agent = targets.agents.find((item) => item.id === targets.defaultAgentId) ?? undefined;
  if (agent !== undefined) {
    write(`Using default agent '${agent.name}'. Override with --agent for this run.`);
  } else {
    write("This host has no agents yet; continuing without a default agent.");
  }
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    agentId: agent?.id,
    agentName: agent?.name,
  };
}

/**
 * Interactive Workspace → Project → default Agent selection. Workspaces with
 * zero bindable projects are hidden unless every workspace is empty; any
 * level with exactly one option is auto-selected with a printed note.
 */
export async function pickTargets(
  targets: RunnerTargetsResponse,
  deps: PickerDeps = {},
): Promise<PickedTargets> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const isTTY = deps.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  const choose = deps.choose ?? readlineChoose;
  if (!isTTY) throw nonTTYError();

  if (targets.workspaces.length === 0) {
    throw new Error("This host has no accessible workspaces. Ask for access, then retry.");
  }
  const bindable = targets.workspaces.filter((item) => item.projects.length > 0);
  const workspaceOptions = (bindable.length > 0 ? bindable : targets.workspaces).map((item) => ({
    label:
      item.projects.length > 0
        ? `${item.name} (${item.projects.length} project${item.projects.length === 1 ? "" : "s"})`
        : `${item.name} (no bindable projects)`,
    value: item,
  }));
  let workspace = workspaceOptions[0]?.value;
  if (workspace === undefined) throw new Error("This host has no accessible workspaces.");
  if (workspaceOptions.length === 1 && workspace !== undefined) {
    write(`Using workspace '${workspace.name}' (only available workspace).`);
  } else {
    const chosen = await choose("Select a workspace:", workspaceOptions);
    if (chosen === null || chosen === undefined) throw pickerCancelledError();
    workspace = chosen;
  }

  if (workspace.projects.length === 0) {
    throw new Error(
      `Workspace '${workspace.name}' has no projects you can contribute to. ` +
        `Ask a workspace owner for Contribute access, or choose another workspace with --workspace.`,
    );
  }
  let project = workspace.projects[0]!;
  if (workspace.projects.length === 1) {
    write(`Using project '${project.name}' (${project.key}; only available project).`);
  } else {
    const chosen = await choose(
      `Select a project in workspace '${workspace.name}':`,
      workspace.projects.map((item) => ({ label: `${item.name} (${item.key})`, value: item })),
    );
    if (chosen === null || chosen === undefined) throw pickerCancelledError();
    project = chosen;
  }

  const agent = targets.agents.find((item) => item.id === targets.defaultAgentId) ?? undefined;
  if (agent !== undefined) {
    write(`Using default agent '${agent.name}'. Override with --agent for this run.`);
  } else {
    write("This host has no agents yet; continuing without a default agent.");
  }
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    agentId: agent?.id,
    agentName: agent?.name,
  };
}
