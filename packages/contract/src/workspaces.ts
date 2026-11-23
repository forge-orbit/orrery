import { z } from "zod";
import { AvatarUrl } from "./auth.ts";
import { Email, NewPassword, WorkspaceKind } from "./common.ts";
import { InvitationGrant, InvitationStatus, WorkspaceInvitationProjectGrant } from "./invitations.ts";










export const workspaceCapabilities = [
  "canCreateProjects",
  "canInviteMembers",
  "canRemoveMembers",
  "canManageMemberPermissions",
] as const;
export type WorkspaceCapability = (typeof workspaceCapabilities)[number];







export const Workspace = z
  .object({
    id: z.string(),
    kind: WorkspaceKind,
    name: z.string(),
    isOwner: z.boolean(),
    canCreateProjects: z.boolean(),
    canInviteMembers: z.boolean(),
    canRemoveMembers: z.boolean(),
    canManageMemberPermissions: z.boolean(),
  })
  .meta({ id: "Workspace" });
export type Workspace = z.infer<typeof Workspace>;

export const WorkspacesResponse = z.array(Workspace).meta({ id: "WorkspacesResponse" });
export type WorkspacesResponse = z.infer<typeof WorkspacesResponse>;


export const CreateWorkspaceRequest = z
  .object({
    name: z.string().trim().min(1, "Name the workspace.").max(120),
  })
  .meta({ id: "CreateWorkspaceRequest" });
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;



export const WorkspaceMember = z
  .object({
    humanId: z.string(),
    email: Email,
    displayName: z.string().nullable(),
    avatarUrl: AvatarUrl.nullable(),
    isOwner: z.boolean(),
    
    canCreateProjects: z.boolean(),
    canInviteMembers: z.boolean(),
    canRemoveMembers: z.boolean(),
    canManageMemberPermissions: z.boolean(),
  })
  .meta({ id: "WorkspaceMember" });
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;





export const UpdateWorkspaceMemberRequest = z
  .object({
    canCreateProjects: z.boolean().optional(),
    canInviteMembers: z.boolean().optional(),
    canRemoveMembers: z.boolean().optional(),
    canManageMemberPermissions: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Provide at least one capability to grant or revoke.",
  })
  .meta({ id: "UpdateWorkspaceMemberRequest" });
export type UpdateWorkspaceMemberRequest = z.infer<typeof UpdateWorkspaceMemberRequest>;

export const WorkspaceMembersResponse = z
  .array(WorkspaceMember)
  .meta({ id: "WorkspaceMembersResponse" });
export type WorkspaceMembersResponse = z.infer<typeof WorkspaceMembersResponse>;

export const HumanSuggestionsQuery = z
  .object({
    q: z.string().trim().min(1).max(120),
  })
  .meta({ id: "HumanSuggestionsQuery" });
export type HumanSuggestionsQuery = z.infer<typeof HumanSuggestionsQuery>;

export const HumanSuggestion = z
  .object({
    humanId: z.string(),
    email: Email,
    displayName: z.string().nullable(),
    avatarUrl: AvatarUrl.nullable(),
  })
  .meta({ id: "HumanSuggestion" });
export type HumanSuggestion = z.infer<typeof HumanSuggestion>;

export const HumanSuggestionsResponse = z
  .array(HumanSuggestion)
  .meta({ id: "HumanSuggestionsResponse" });
export type HumanSuggestionsResponse = z.infer<typeof HumanSuggestionsResponse>;





export const InviteWorkspaceMemberRequest = z
  .object({
    email: Email,
    projectGrants: z.array(WorkspaceInvitationProjectGrant).max(100).refine(
      (grants) => new Set(grants.map((grant) => grant.projectId)).size === grants.length,
      "Offer each project at most once.",
    ).default([]),
  })
  .meta({ id: "InviteWorkspaceMemberRequest" });
export type InviteWorkspaceMemberRequest = z.infer<typeof InviteWorkspaceMemberRequest>;



export const WorkspaceInvitation = z
  .object({
    workspaceId: z.string(),
    email: Email,
    status: InvitationStatus,
  })
  .meta({ id: "WorkspaceInvitation" });
export type WorkspaceInvitation = z.infer<typeof WorkspaceInvitation>;





export const WorkspaceInvitationPreview = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    email: Email,
    invitedByEmail: Email,
    accountExists: z.boolean(),
    grants: z.array(InvitationGrant),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "WorkspaceInvitationPreview" });
export type WorkspaceInvitationPreview = z.infer<typeof WorkspaceInvitationPreview>;




export const WorkspaceInvitationToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,1024}$/)
  .meta({ id: "WorkspaceInvitationToken" });
export type WorkspaceInvitationToken = z.infer<typeof WorkspaceInvitationToken>;




export const AcceptWorkspaceInvitationRequest = z
  .object({
    token: WorkspaceInvitationToken,
  })
  .meta({ id: "AcceptWorkspaceInvitationRequest" });
export type AcceptWorkspaceInvitationRequest = z.infer<typeof AcceptWorkspaceInvitationRequest>;



export const DeclineWorkspaceInvitationRequest = z
  .object({
    token: WorkspaceInvitationToken,
  })
  .meta({ id: "DeclineWorkspaceInvitationRequest" });
export type DeclineWorkspaceInvitationRequest = z.infer<
  typeof DeclineWorkspaceInvitationRequest
>;



export const RegisterThroughWorkspaceInvitationRequest = z
  .object({
    token: WorkspaceInvitationToken,
    password: NewPassword,
  })
  .meta({ id: "RegisterThroughWorkspaceInvitationRequest" });
export type RegisterThroughWorkspaceInvitationRequest = z.infer<
  typeof RegisterThroughWorkspaceInvitationRequest
>;



export const AppointWorkspaceOwnerRequest = z
  .object({
    humanId: z.string().min(1).max(200),
  })
  .meta({ id: "AppointWorkspaceOwnerRequest" });
export type AppointWorkspaceOwnerRequest = z.infer<typeof AppointWorkspaceOwnerRequest>;
