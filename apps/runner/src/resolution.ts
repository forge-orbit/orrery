import type { RunnerTargetsResponse } from "@orrery/contract";
import type { OrreryClient } from "./client.ts";
import { RunnerRequestError } from "./client.ts";
import type { RepoBinding } from "./repos.ts";
import { nonTTYError, pickProjectInWorkspace, pickTargets } from "./picker.ts";
import type { ChooseFn } from "./picker.ts";
export type { ChooseFn };
import { isUuidLike, resolveAgent, resolveProject, resolveWorkspace } from "./targets.ts";

/**
 * Resolution precedence for `start` and `init` (#267):
 * explicit flags > saved binding (where consistent) > interactive picker
 * (TTY only) > non-TTY fail-fast.
 *
 * `GET /api/runners/targets` is skipped completely when every required ID
 * comes from a saved binding or explicit UUIDs and no human-readable flag
 * needs resolution.
 */

export interface TargetFlags {
  workspace?: string | undefined;
  project?: string | undefined;
  agent?: string | undefined;
}

export interface TargetClient {
  readonly server: string;
  getTargets(): Promise<RunnerTargetsResponse>;
}

export interface ResolutionRequest {
  client: TargetClient;
  flags: TargetFlags;
  binding: RepoBinding | undefined;
  bindingFingerprint: string;
  storedHostId: string;
  write: (line: string) => void;
  choose?: ChooseFn | undefined;
  isTTY: boolean;
  /** `init` always persists; `start` persists only when previously unbound. */
  alwaysSave: boolean;
}

export interface ResolvedTargets {
  workspaceId: string;
  projectId: string;
  agentId: string | undefined;
  workspaceName: string | undefined;
  projectKey: string | undefined;
  agentName: string | undefined;
  /** Entry to persist (after successful registration for `start`). */
  bindingToSave: RepoBinding | null;
  notices: string[];
  targetsFetched: boolean;
}

const normalize = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** 401 on the host-authenticated discovery endpoint: re-enroll. */
export function mapTargetsError(error: unknown): Error {
  if (error instanceof RunnerRequestError) {
    if (error.status === 401) {
      return new Error(
        `Orrery rejected the Runner host credential (401). ` +
          `Run 'orrery-runner login' to re-enroll this host, then retry.`,
      );
    }
    if (error.status === 409 && error.code === "targets_too_large") {
      return new Error(
        "Orrery returned 409 (targets_too_large): too many workspaces, projects or agents to list. " +
          "Pass explicit UUIDs instead, for example " +
          "'orrery-runner start --workspace <UUID> --project <UUID>'.",
      );
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

const staleWorkspaceError = (workspaceId: string): Error =>
  new Error(
    `The saved binding points at workspace '${workspaceId}', which is no longer accessible ` +
      `(access revoked or workspace removed). Run 'orrery-runner start --reconfigure' or ` +
      `'orrery-runner init --workspace <ID> --project <ID>' to choose new targets. ` +
      `The saved binding was left unchanged.`,
  );

/**
 * Map a stale-binding `registerRunner` failure to a distinct remediation
 * without auto-deleting `repos.json`. Returns the original error when it is
 * not a recognized registration failure.
 */
export function mapRegistrationError(
  error: unknown,
  ids: { workspaceId: string; projectId: string },
): Error {
  if (!(error instanceof RunnerRequestError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const unchanged = "The saved binding was left unchanged.";
  if (error.status === 401) {
    return new Error(
      `Orrery rejected the Runner host credential (401). ` +
        `Run 'orrery-runner login' to re-enroll this host, then retry. ${unchanged}`,
    );
  }
  if (error.status === 404 && error.code === "workspace_not_found") {
    return new Error(
      `The saved workspace '${ids.workspaceId}' is no longer accessible ` +
        `(access revoked or workspace removed). Run 'orrery-runner start --reconfigure' or ` +
        `'orrery-runner init --workspace <ID> --project <ID>' to choose new targets. ${unchanged}`,
    );
  }
  if (error.status === 404 && error.code === "project_not_found") {
    return new Error(
      `The saved project '${ids.projectId}' was not found. It may have been moved to Trash ` +
        `(restorable for 30 days) or your access was revoked. Run ` +
        `'orrery-runner start --reconfigure' or 'orrery-runner init --workspace <ID> --project <ID>' ` +
        `to choose new targets. ${unchanged}`,
    );
  }
  if (error.status === 404 && error.code === "agent_not_found") {
    return new Error(
      `The saved agent is no longer available (deleted or not owned by this host's human). ` +
        `Run 'orrery-runner start --reconfigure' or pass --agent explicitly. ${unchanged}`,
    );
  }
  if (error.status === 409 && error.code === "no_default_agent") {
    return new Error(
      `This host's human has no agent to run as by default. Create an agent, then run ` +
        `'orrery-runner start --reconfigure' or pass --agent explicitly. ${unchanged}`,
    );
  }
  return error;
}

function agentNameFor(
  targets: RunnerTargetsResponse,
  agentId: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (agentId === undefined) return undefined;
  return targets.agents.find((item) => item.id === agentId)?.name ?? fallback;
}

export async function resolveTargets(request: ResolutionRequest): Promise<ResolvedTargets> {
  const flags: TargetFlags = {
    workspace: normalize(request.flags.workspace),
    project: normalize(request.flags.project),
    agent: normalize(request.flags.agent),
  };
  const notices: string[] = [];
  if (request.binding?.hostId !== undefined && request.binding.hostId !== request.storedHostId) {
    notices.push(
      `Note: the saved binding was created under a different Runner host enrollment ` +
        `(host '${request.binding.hostId}'); continuing with this host ('${request.storedHostId}'). ` +
        `Live permissions apply at registration.`,
    );
  }

  const workspaceId = flags.workspace ?? request.binding?.workspaceId;

  const projectId = flags.project ?? request.binding?.projectId;
  const humanReadable = [flags.workspace, flags.project, flags.agent].some(
    (value) => value !== undefined && !isUuidLike(value),
  );

  // Fast path: every required ID is already known and nothing needs a name
  // lookup. No `GET /api/runners/targets`, no prompting.
  if (!humanReadable && workspaceId !== undefined && projectId !== undefined) {
    const agentId = flags.agent ?? request.binding?.agentId;
    if (
      request.binding !== undefined &&
      (flags.workspace !== undefined || flags.project !== undefined || flags.agent !== undefined)
    ) {
      notices.push(
        "Explicit flags override the saved binding for this run; the saved binding was left unchanged.",
      );
    }
    const save = request.alwaysSave || request.binding === undefined;
    for (const notice of notices) request.write(notice);
    return {
      workspaceId,
      projectId,
      agentId,
      workspaceName: request.binding?.workspaceName,
      projectKey: request.binding?.projectKey,
      agentName: flags.agent === undefined ? request.binding?.agentName : undefined,
      bindingToSave: save
        ? {
            server: request.client.server,
            bindingFingerprint: request.bindingFingerprint,
            workspaceId,
            projectId,
            ...(agentId === undefined ? {} : { agentId }),
            hostId: request.storedHostId,
            ...(request.binding?.workspaceName === undefined
              ? {}
              : { workspaceName: request.binding.workspaceName }),
            ...(request.binding?.projectKey === undefined
              ? {}
              : { projectKey: request.binding.projectKey }),
            ...(flags.agent === undefined && request.binding?.agentName !== undefined
              ? { agentName: request.binding.agentName }
              : {}),
            updatedAt: new Date().toISOString(),
          }
        : null,
      notices,
      targetsFetched: false,
    };
  }

  // A full picker is certain (no flags, no binding): fail fast in non-TTY
  // before any network call.
  if (
    workspaceId === undefined &&
    projectId === undefined &&
    request.binding === undefined &&
    !request.isTTY
  ) {
    throw nonTTYError();
  }

  let targets: RunnerTargetsResponse;
  try {
    targets = await request.client.getTargets();
  } catch (error) {
    throw mapTargetsError(error);
  }

  let resolvedWorkspaceId: string;
  let resolvedWorkspaceName: string;
  let resolvedProjectId: string;
  let resolvedProjectKey: string;
  let resolvedProjectName: string;

  if (flags.workspace !== undefined) {
    const workspace = resolveWorkspace(targets, flags.workspace);
    if (flags.project !== undefined) {
      const hit = resolveProject(targets, flags.project, workspace);
      resolvedWorkspaceId = workspace.id;
      resolvedWorkspaceName = workspace.name;
      resolvedProjectId = hit.projectId;
      resolvedProjectKey = hit.projectKey;
      resolvedProjectName = hit.projectName;
    } else if (request.binding !== undefined) {
      const bound = workspace.projects.find((item) => item.id === request.binding!.projectId);
      if (bound === undefined) {
        throw new Error(
          `The saved project '${request.binding.projectKey ?? request.binding.projectId}' ` +
            `is not in workspace '${workspace.name}'. Pass --project explicitly or run ` +
            `'orrery-runner start --reconfigure' to choose new targets. ` +
            `The saved binding was left unchanged.`,
        );
      }
      resolvedWorkspaceId = workspace.id;
      resolvedWorkspaceName = workspace.name;
      resolvedProjectId = bound.id;
      resolvedProjectKey = bound.key;
      resolvedProjectName = bound.name;
    } else {
      const picked = await pickProjectInWorkspace(workspace, targets, {
        choose: request.choose,
        isTTY: request.isTTY,
        write: request.write,
      });
      resolvedWorkspaceId = picked.workspaceId;
      resolvedWorkspaceName = picked.workspaceName;
      resolvedProjectId = picked.projectId;
      resolvedProjectKey = picked.projectKey;
      resolvedProjectName = picked.projectName;
      return finish(request, notices, {
        workspaceId: resolvedWorkspaceId,
        workspaceName: resolvedWorkspaceName,
        projectId: resolvedProjectId,
        projectKey: resolvedProjectKey,
        projectName: resolvedProjectName,
        agentId: picked.agentId,
        agentName: picked.agentName,
      });
    }
  } else if (flags.project !== undefined) {
    if (request.binding !== undefined) {
      // A lone --project is verified inside the bound workspace first: it
      // must never silently switch workspaces.
      const bound = targets.workspaces.find((item) => item.id === request.binding!.workspaceId);
      if (bound === undefined) throw staleWorkspaceError(request.binding.workspaceId);
      let hit: { projectId: string; projectKey: string; projectName: string };
      try {
        hit = resolveProject(targets, flags.project, bound);
      } catch (error) {
        throw new Error(
          `No project matches '${flags.project}' in workspace '${bound.name}' (from the saved binding). ` +
            `Pass --project with an exact ID, key or name within that workspace, or run ` +
            `'orrery-runner start --reconfigure' to switch workspaces. ` +
            `The saved binding was left unchanged.`,
          { cause: error },
        );
      }
      resolvedWorkspaceId = bound.id;
      resolvedWorkspaceName = bound.name;
      resolvedProjectId = hit.projectId;
      resolvedProjectKey = hit.projectKey;
      resolvedProjectName = hit.projectName;
    } else {
      const hit = resolveProject(targets, flags.project, undefined);
      resolvedWorkspaceId = hit.workspace.id;
      resolvedWorkspaceName = hit.workspace.name;
      resolvedProjectId = hit.projectId;
      resolvedProjectKey = hit.projectKey;
      resolvedProjectName = hit.projectName;
    }
  } else if (request.binding !== undefined) {
    // Only --agent (human-readable) was passed: the saved Workspace/Project
    // still scope the run, so confirm the binding workspace is visible.
    const bound = targets.workspaces.find((item) => item.id === request.binding!.workspaceId);
    if (bound === undefined) throw staleWorkspaceError(request.binding.workspaceId);
    const project = bound.projects.find((item) => item.id === request.binding!.projectId);
    if (project === undefined) {
      throw new Error(
        `The saved project '${request.binding.projectKey ?? request.binding.projectId}' ` +
          `is no longer available in workspace '${bound.name}'. Run ` +
          `'orrery-runner start --reconfigure' to choose new targets. ` +
          `The saved binding was left unchanged.`,
      );
    }
    resolvedWorkspaceId = bound.id;
    resolvedWorkspaceName = bound.name;
    resolvedProjectId = project.id;
    resolvedProjectKey = project.key;
    resolvedProjectName = project.name;
  } else {
    const picked = await pickTargets(targets, {
      choose: request.choose,
      isTTY: request.isTTY,
      write: request.write,
    });
    return finish(request, notices, {
      workspaceId: picked.workspaceId,
      workspaceName: picked.workspaceName,
      projectId: picked.projectId,
      projectKey: picked.projectKey,
      projectName: picked.projectName,
      agentId: picked.agentId,
      agentName: picked.agentName,
    });
  }

  const agentId =
    flags.agent !== undefined
      ? resolveAgent(targets, flags.agent)
      : (request.binding?.agentId ?? targets.defaultAgentId ?? undefined);
  return finish(request, notices, {
    workspaceId: resolvedWorkspaceId,
    workspaceName: resolvedWorkspaceName,
    projectId: resolvedProjectId,
    projectKey: resolvedProjectKey,
    projectName: resolvedProjectName,
    agentId,
    agentName: agentNameFor(targets, agentId, request.binding?.agentName),
  });
}

function finish(
  request: ResolutionRequest,
  notices: string[],
  resolved: {
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    projectKey: string;
    projectName: string;
    agentId: string | undefined;
    agentName: string | undefined;
  },
): ResolvedTargets {
  const shouldSave = request.alwaysSave || request.binding === undefined;
  if (
    !shouldSave &&
    (request.flags.workspace !== undefined ||
      request.flags.project !== undefined ||
      request.flags.agent !== undefined)
  ) {
    notices.push(
      "Explicit flags override the saved binding for this run; the saved binding was left unchanged.",
    );
  }
  for (const notice of notices) request.write(notice);
  return {
    workspaceId: resolved.workspaceId,
    projectId: resolved.projectId,
    agentId: resolved.agentId,
    workspaceName: resolved.workspaceName,
    projectKey: resolved.projectKey,
    agentName: resolved.agentName,
    bindingToSave: shouldSave
      ? {
          server: request.client.server,
          bindingFingerprint: request.bindingFingerprint,
          workspaceId: resolved.workspaceId,
          projectId: resolved.projectId,
          ...(resolved.agentId === undefined ? {} : { agentId: resolved.agentId }),
          hostId: request.storedHostId,
          workspaceName: resolved.workspaceName,
          projectKey: resolved.projectKey,
          ...(resolved.agentName === undefined ? {} : { agentName: resolved.agentName }),
          updatedAt: new Date().toISOString(),
        }
      : null,
    notices,
    targetsFetched: true,
  };
}

/**
 * Resolve a human-readable `--agent` flag for one-shot `work` runs:
 * UUID-shaped values pass through for server-side validation, names resolve
 * against the host's top-level `targets.agents`.
 */
export async function resolveWorkAgent(
  client: OrreryClient,
  raw: string,
): Promise<string | undefined> {
  if (isUuidLike(raw)) return raw;
  let targets: Awaited<ReturnType<OrreryClient["getTargets"]>>;
  try {
    targets = await client.getTargets();
  } catch (error) {
    throw mapTargetsError(error);
  }
  return resolveAgent(targets, raw);
}
