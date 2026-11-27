import type {
  RunnerTargetAgent,
  RunnerTargetsResponse,
  RunnerTargetWorkspace,
} from "@orrery/contract";

/**
 * Client-side human-readable target resolution over
 * `GET /api/runners/targets` (#267). Matching is deterministic and shared by
 * `start`, `init`, and `--agent` in `work`. Zero or ambiguous matches fail
 * with non-enumerating errors that list only the host owner's own authorized
 * candidates and IDs (everything in `targets` is already scoped to the
 * caller, so listing it reveals nothing new).
 */

/** UUID-shaped values are server-validated, never resolved client-side. */
export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const describeWorkspaces = (workspaces: RunnerTargetWorkspace[]): string =>
  workspaces.map((item) => `'${item.name}' (${item.id})`).join(", ");

const noWorkspaceMatch = (raw: string, targets: RunnerTargetsResponse): Error => {
  if (targets.workspaces.length === 0) {
    return new Error(
      `No workspace matches '${raw}': this host has no accessible workspaces. ` +
        `Ask for access, then retry.`,
    );
  }
  return new Error(
    `No workspace matches '${raw}'. Your accessible workspaces: ` +
      `${describeWorkspaces(targets.workspaces)}. ` +
      `Pass --workspace with an exact ID, name or slug.`,
  );
};

const ambiguousWorkspaceError = (raw: string, matches: RunnerTargetWorkspace[]): Error =>
  new Error(
    `Workspace '${raw}' is ambiguous. Matching workspaces: ` +
      `${describeWorkspaces(matches)}. Pass --workspace with an exact ID.`,
  );

/**
 * Resolve `--workspace`: exact ID → exact name → exact slug (ignoring empty
 * slugs) → unique case-insensitive name/slug. Duplicate exact names or slugs
 * fail with an ambiguity error instead of silently picking the first.
 */
export function resolveWorkspace(
  targets: RunnerTargetsResponse,
  raw: string,
): RunnerTargetWorkspace {
  const byId = targets.workspaces.find((item) => item.id === raw);
  if (byId !== undefined) return byId;
  const byName = targets.workspaces.filter((item) => item.name === raw);
  if (byName.length > 1) throw ambiguousWorkspaceError(raw, byName);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  if (raw !== "") {
    const bySlug = targets.workspaces.filter((item) => item.slug !== "" && item.slug === raw);
    if (bySlug.length > 1) throw ambiguousWorkspaceError(raw, bySlug);
    if (bySlug.length === 1 && bySlug[0] !== undefined) return bySlug[0];
  }
  const lowered = raw.toLowerCase();
  const fuzzy = targets.workspaces.filter(
    (item) =>
      item.name.toLowerCase() === lowered ||
      (item.slug !== "" && item.slug.toLowerCase() === lowered),
  );
  if (fuzzy.length === 1 && fuzzy[0] !== undefined) return fuzzy[0];
  if (fuzzy.length > 1) throw ambiguousWorkspaceError(raw, fuzzy);
  throw noWorkspaceMatch(raw, targets);
}

export interface ResolvedProject {
  workspace: RunnerTargetWorkspace;
  projectId: string;
  projectKey: string;
  projectName: string;
}

const describeProjects = (
  matches: Array<{ workspaceName: string; name: string; key: string; id: string }>,
): string =>
  matches
    .map((item) => `'${item.name}' (${item.key}, ${item.id}) in workspace '${item.workspaceName}'`)
    .join(", ");

const emptyWorkspaceError = (workspace: RunnerTargetWorkspace): Error =>
  new Error(
    `Workspace '${workspace.name}' has no projects you can contribute to. ` +
      `Ask a workspace owner for Contribute access, or choose another workspace with --workspace.`,
  );

const noProjectMatch = (
  raw: string,
  scope: RunnerTargetWorkspace | undefined,
  targets: RunnerTargetsResponse,
): Error => {
  const candidates =
    scope === undefined
      ? targets.workspaces.flatMap((workspace) =>
          workspace.projects.map((project) => ({
            workspaceName: workspace.name,
            name: project.name,
            key: project.key,
            id: project.id,
          })),
        )
      : scope.projects.map((project) => ({
          workspaceName: scope.name,
          name: project.name,
          key: project.key,
          id: project.id,
        }));
  if (candidates.length === 0) {
    if (scope !== undefined) throw emptyWorkspaceError(scope);
    return new Error(
      `No project matches '${raw}': this host has no accessible projects. ` +
        `Ask for Contribute access, then retry.`,
    );
  }
  const where = scope === undefined ? "" : ` in workspace '${scope.name}'`;
  return new Error(
    `No project matches '${raw}'${where}. Your accessible projects${where}: ` +
      `${describeProjects(candidates)}. Pass --project with an exact ID, key or name.`,
  );
};

function matchProjects(
  workspaces: RunnerTargetWorkspace[],
  predicate: (project: RunnerTargetWorkspace["projects"][number]) => boolean,
  ambiguityPrefix: string,
): ResolvedProject | undefined {
  const matches = workspaces.flatMap((workspace) =>
    workspace.projects.filter(predicate).map((project) => ({ workspace, project })),
  );
  if (matches.length === 1 && matches[0] !== undefined) {
    const hit = matches[0];
    return {
      workspace: hit.workspace,
      projectId: hit.project.id,
      projectKey: hit.project.key,
      projectName: hit.project.name,
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `${ambiguityPrefix}. Matching projects: ` +
        `${describeProjects(matches.map((hit) => ({ workspaceName: hit.workspace.name, name: hit.project.name, key: hit.project.key, id: hit.project.id })))}. ` +
        `Pass --project with an exact ID, or add --workspace to choose one.`,
    );
  }
  return undefined;
}

/**
 * Resolve `--project`: exact ID → case-insensitive Project key → unique
 * exact name. Scoped to the resolved Workspace when one is given (or when a
 * saved binding scopes it); otherwise resolved globally, failing on
 * ambiguity.
 */
export function resolveProject(
  targets: RunnerTargetsResponse,
  raw: string,
  scope: RunnerTargetWorkspace | undefined,
): ResolvedProject {
  const workspaces = scope === undefined ? targets.workspaces : [scope];
  for (const workspace of workspaces) {
    const byId = workspace.projects.find((project) => project.id === raw);
    if (byId !== undefined) {
      return {
        workspace,
        projectId: byId.id,
        projectKey: byId.key,
        projectName: byId.name,
      };
    }
  }
  const lowered = raw.toLowerCase();
  const byKey = matchProjects(
    workspaces,
    (project) => project.key.toLowerCase() === lowered,
    `Project '${raw}' is ambiguous across workspaces`,
  );
  if (byKey !== undefined) return byKey;
  const byName = matchProjects(
    workspaces,
    (project) => project.name === raw,
    `Project '${raw}' is ambiguous`,
  );
  if (byName !== undefined) return byName;
  throw noProjectMatch(raw, scope, targets);
}

const describeAgents = (agents: RunnerTargetAgent[]): string =>
  agents.map((item) => `'${item.name}' (${item.id})`).join(", ");

/**
 * Resolve `--agent`: UUID-shaped values pass through for server-side
 * validation; otherwise exact name → unique case-insensitive name against
 * the top-level (installation-wide, human-scoped) `targets.agents`.
 * Returns the agent ID, or `undefined` when no flag was given and the
 * response carries no default (the server then reports `no_default_agent`).
 */
export function resolveAgent(
  targets: RunnerTargetsResponse,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return targets.defaultAgentId ?? undefined;
  if (isUuidLike(raw)) return raw;
  const byName = targets.agents.find((item) => item.name === raw);
  if (byName !== undefined) return byName.id;
  const lowered = raw.toLowerCase();
  const fuzzy = targets.agents.filter((item) => item.name.toLowerCase() === lowered);
  if (fuzzy.length === 1 && fuzzy[0] !== undefined) return fuzzy[0].id;
  if (fuzzy.length > 1) {
    throw new Error(
      `Agent '${raw}' is ambiguous. Matching agents: ${describeAgents(fuzzy)}. ` +
        `Pass --agent with an exact ID.`,
    );
  }
  if (targets.agents.length === 0) {
    throw new Error(
      `No agent matches '${raw}': this host has no agents. Create an Agent, then retry.`,
    );
  }
  throw new Error(
    `No agent matches '${raw}'. Your accessible agents: ${describeAgents(targets.agents)}. ` +
      `Pass --agent with an exact ID or name.`,
  );
}
