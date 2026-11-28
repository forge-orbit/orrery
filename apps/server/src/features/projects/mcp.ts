import type { McpServer } from "@modelcontextprotocol/server";
import {
  AssigneeHumanId,
  CreateIssueRequest,
  IssueLinkKind,
  IssuePriority,
  IssueStatus,
  IssueSortOrder,
  projectTools,
} from "@orrery/contract";
import {
  assertDispatchToolAllowed,
  isAgentError,
  type AgentAuthenticator,
} from "../agents/index.ts";
import { ProjectsError, type ProjectsService, type WorkActor } from "./service.ts";

type Args = Record<string, unknown>;
type Strategy = (actor: WorkActor, args: Args) => Promise<Args>;

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  return value;
};

const priority = (value: unknown): IssuePriority | undefined =>
  value === undefined ? undefined : IssuePriority.parse(value);
const sortOrder = (value: unknown): number | undefined =>
  value === undefined ? undefined : IssueSortOrder.parse(value);

const assigneeHumanId = (value: unknown): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : AssigneeHumanId.parse(value);

const labelIds = (value: unknown): string[] | undefined =>
  value === undefined ? undefined : CreateIssueRequest.shape.labelIds.parse(value);

const parentIssueId = (value: unknown): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : str(value, "parentIssueId");

export function createProjectsMcp(service: ProjectsService, authenticate: AgentAuthenticator) {
  const strategies: Record<string, Strategy> = {
    list_projects: async (actor, args) => ({
      projects: await service.listProjects(actor, str(args.workspaceId, "workspaceId")),
    }),
    get_project: async (actor, args) => ({
      project: await service.getProject(actor, str(args.projectId, "projectId")),
    }),
    list_issues: async (actor, args) => ({
      issues: await service.listIssues(actor, str(args.projectId, "projectId")),
    }),
    get_issue: async (actor, args) => ({
      issue: await service.getIssue(actor, str(args.issueId, "issueId")),
    }),
    create_issue: async (actor, args) => ({
      issue: await service.createIssue(actor, str(args.projectId, "projectId"), {
        title: str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
        status: args.status === undefined ? undefined : IssueStatus.parse(args.status),
        priority: priority(args.priority),
        sortOrder: sortOrder(args.sortOrder),
        assigneeHumanId: assigneeHumanId(args.assigneeHumanId),
        labelIds: labelIds(args.labelIds),
        parentIssueId: parentIssueId(args.parentIssueId),
      }),
    }),
    update_issue: async (actor, args) => ({
      issue: await service.updateIssue(actor, str(args.issueId, "issueId"), {
        title: args.title === undefined ? undefined : str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
        status: args.status === undefined ? undefined : IssueStatus.parse(args.status),
        priority: priority(args.priority),
        sortOrder: sortOrder(args.sortOrder),
        assigneeHumanId: assigneeHumanId(args.assigneeHumanId),
        parentIssueId: parentIssueId(args.parentIssueId),
      }),
    }),
    list_labels: async (actor, args) => ({
      labels: await service.listLabels(actor, str(args.projectId, "projectId")),
    }),
    create_label: async (actor, args) => ({
      label: await service.createLabel(actor, str(args.projectId, "projectId"), {
        name: str(args.name, "name"),
        color: str(args.color, "color"),
      }),
    }),
    update_label: async (actor, args) => ({
      label: await service.updateLabel(actor, str(args.labelId, "labelId"), {
        name: args.name === undefined ? undefined : str(args.name, "name"),
        color: args.color === undefined ? undefined : str(args.color, "color"),
      }),
    }),
    delete_label: async (actor, args) => {
      await service.deleteLabel(actor, str(args.labelId, "labelId"));
      return { removed: true as const };
    },
    attach_issue_label: async (actor, args) => ({
      issue: await service.attachLabel(
        actor,
        str(args.issueId, "issueId"),
        str(args.labelId, "labelId"),
      ),
    }),
    detach_issue_label: async (actor, args) => ({
      issue: await service.detachLabel(
        actor,
        str(args.issueId, "issueId"),
        str(args.labelId, "labelId"),
      ),
    }),
    add_blocked_by: async (actor, args) => ({
      dependency: await service.addBlockedBy(actor, str(args.issueId, "issueId"), {
        blockedByIssueId: str(args.blockedByIssueId, "blockedByIssueId"),
      }),
    }),
    remove_blocked_by: async (actor, args) => {
      await service.removeBlockedBy(
        actor,
        str(args.issueId, "issueId"),
        str(args.blockedByIssueId, "blockedByIssueId"),
      );
      return { removed: true as const };
    },
    list_blocked_by: async (actor, args) => ({
      issues: await service.listBlockedBy(actor, str(args.issueId, "issueId")),
    }),
    list_blocking: async (actor, args) => ({
      issues: await service.listBlocking(actor, str(args.issueId, "issueId")),
    }),
    list_comments: async (actor, args) => ({
      comments: await service.listComments(actor, str(args.issueId, "issueId")),
    }),
    create_comment: async (actor, args) => ({
      comment: await service.createComment(actor, str(args.issueId, "issueId"), {
        body: str(args.body, "body"),
      }),
    }),
    add_issue_link: async (actor, args) => ({
      link: await service.addIssueLink(actor, str(args.issueId, "issueId"), {
        url: str(args.url, "url"),
        title: str(args.title, "title"),
        kind: IssueLinkKind.parse(args.kind),
      }),
    }),
    remove_issue_link: async (actor, args) => {
      await service.removeIssueLink(
        actor,
        str(args.issueId, "issueId"),
        str(args.linkId, "linkId"),
      );
      return { removed: true };
    },
    list_activity: async (actor, args) => ({
      activity: await service.listActivity(actor, str(args.projectId, "projectId")),
    }),
    list_knowledge: async (actor, args) => ({
      entries: await service.listKnowledge(actor, str(args.projectId, "projectId")),
    }),
    get_knowledge: async (actor, args) => ({
      entry: await service.getKnowledge(actor, str(args.entryId, "entryId")),
    }),
    create_knowledge: async (actor, args) => ({
      entry: await service.createKnowledge(actor, str(args.projectId, "projectId"), {
        title: str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
      }),
    }),
    update_knowledge: async (actor, args) => ({
      entry: await service.updateKnowledge(actor, str(args.entryId, "entryId"), {
        title: args.title === undefined ? undefined : str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
      }),
    }),
  };

  for (const tool of projectTools) {
    if (!(tool.name in strategies)) throw new Error(`no strategy for MCP tool ${tool.name}`);
  }

  return (server: McpServer, request: Request): void => {
    for (const tool of projectTools) {
      const strategy = strategies[tool.name];
      if (strategy === undefined) continue;
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          outputSchema: tool.output,
        },
        async (rawArgs) => {
          try {
            const identity = await authenticate(request);
            if (identity === null) throw new ProjectsError("not_signed_in");
            const parsed = tool.input.parse(rawArgs);
            assertDispatchToolAllowed(identity, tool.name, parsed);
            const result = await strategy(
              { kind: "agent", identity },
              Object.fromEntries(Object.entries(parsed)),
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (isAgentError(error) || error instanceof ProjectsError) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ code: error.kind, message: error.message }),
                  },
                ],
                structuredContent: { code: error.kind, message: error.message },
                isError: true,
              };
            }
            throw error;
          }
        },
      );
    }
  };
}
