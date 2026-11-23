import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AcceptWorkspaceInvitationRequest,
  AppointWorkspaceOwnerRequest,
  CreateWorkspaceRequest,
  DeclineWorkspaceInvitationRequest,
  HumanSuggestionsQuery,
  HumanSuggestionsResponse,
  InvitationSummaries,
  InvitationSummary,
  InviteWorkspaceMemberRequest,
  RegisterThroughWorkspaceInvitationRequest,
  SessionResponse,
  UpdateWorkspaceMemberRequest,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitationPreview,
  WorkspaceInvitationToken,
  WorkspaceMember,
  WorkspaceMembersResponse,
  WorkspacesResponse,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { deliveryProblem } from "../settings/index.ts";
import { WorkspacesError, type WorkspacesErrorKind, type WorkspacesService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const memberParams = workspaceParams.extend({ humanId: z.string().min(1).max(200) });
const invitationParams = workspaceParams.extend({ invitationId: z.string().min(1).max(200) });
const previewQuery = z.object({ token: WorkspaceInvitationToken });

const listWorkspaces = createRoute({
  method: "get",
  path: "/api/workspaces",
  summary: "The workspaces the signed-in account can access",
  description:
    "The caller's personal workspace plus every shared workspace they belong to, with whether they own each one. Another person's workspace never appears here, not even for a system administrator.",
  responses: {
    200: {
      description: "The caller's workspaces",
      content: { "application/json": { schema: WorkspacesResponse } },
    },
    401: problem("Not signed in"),
  },
});

const getWorkspace = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}",
  summary: "One workspace the signed-in account can access",
  description:
    "The caller's personal workspace or a shared workspace they belong to. A workspace outside the caller's access answers exactly like a missing one.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace",
      content: { "application/json": { schema: Workspace } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    404: problem("No workspace with this id is accessible to the caller"),
  },
});

const listWorkspaceMembers = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/members",
  summary: "The members of a shared workspace",
  description:
    "Owners and members holding Remove members or Manage member permissions: the directory used to manage a team. An ordinary member without those capabilities does not receive everyone else's address.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace's members",
      content: { "application/json": { schema: WorkspaceMembersResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller lacks the workspace capability required to see the directory"),
    404: problem("No accessible shared workspace"),
  },
});

const suggestHumans = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/human-suggestions",
  summary: "Known Humans to suggest when inviting someone to a shared workspace",
  description:
    "The free-text email field stays authoritative: these are only suggestions, never a directory of the installation. System administrators may find any active Human not already in the workspace. Other owners and delegated inviters — the same authority required to send an invitation — may only find active Humans they already share another workspace with; strangers answer exactly like a query with no matches. Permission managers without invite authority are refused. Deactivated accounts and current members are never suggested.",
  request: { params: workspaceParams, query: HumanSuggestionsQuery },
  responses: {
    200: {
      description: "Up to twenty matching Humans, ordered by email",
      content: { "application/json": { schema: HumanSuggestionsResponse } },
    },
    400: problem("The workspace id or search query is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller lacks the workspace capability required to invite members"),
    404: problem("No accessible shared workspace"),
  },
});

const createWorkspace = createRoute({
  method: "post",
  path: "/api/workspaces",
  summary: "Create a shared workspace",
  description:
    "Creates a shared workspace and makes the signed-in human its first owner in one transaction.",
  request: {
    body: { required: true, content: { "application/json": { schema: CreateWorkspaceRequest } } },
  },
  responses: {
    201: {
      description: "The shared workspace, owned by the creator",
      content: { "application/json": { schema: Workspace } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
  },
});

const inviteWorkspaceMember = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/invitations",
  summary: "Invite an email into a shared workspace",
  description:
    "Owners and delegated inviters, whose email must be verified. A single-use link valid for seven days goes to the invited address, offering workspace membership and any selected project grants. Every offered project must currently belong to the workspace, and a delegated inviter may only offer projects they currently Manage in that workspace. Owners may offer any workspace project. An existing account accepts it after signing in; a new address registers through it. Following the link (GET) changes nothing.",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: { "application/json": { schema: InviteWorkspaceMemberRequest } },
    },
  },
  responses: {
    201: {
      description: "The invitation, pending",
      content: { "application/json": { schema: WorkspaceInvitation } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem(
      "The caller cannot invite, their email is unverified, or they do not Manage an offered project",
    ),
    404: problem("No shared workspace with this id is accessible to the caller"),
    409: problem(
      "The invitee is already a member or already has a pending invitation, an offered project no longer belongs to the workspace, or SMTP is not configured or its stored password is unreadable",
    ),
    502: problem("The SMTP server refused the message; the code says why"),
  },
});

const listWorkspaceInvitations = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/invitations",
  summary: "List a shared workspace's invitations",
  description:
    "Owners and delegated inviters. Every invitation for this workspace, newest first, with recipient, inviter, target, offered grants, lifecycle timestamps, and email delivery as a separate fact. A pending invitation whose seven days have passed is reported and stored as expired. The token never appears.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace's invitations",
      content: { "application/json": { schema: InvitationSummaries } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner or delegated inviter of this workspace"),
    404: problem("No accessible shared workspace"),
  },
});

const resendWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/invitations/{invitationId}/resend",
  summary: "Resend a workspace invitation",
  description:
    "Owners and delegated inviters, whose email must be verified exactly as for an initial invitation. A delegate may only resend an offer whose projects they currently Manage. Rotates the link: a still-live pending invitation becomes revoked at replacement time, one past its deadline becomes expired at the deadline it passed, and a new pending invitation from the current inviter starts a fresh seven-day deadline. The previous link stops working. A delivery failure is recorded on the new invitation and answered as a delivery Problem; the invitation's lifecycle stays pending. Answers 409 invitation_not_pending when the invitation is accepted, declined, or revoked; invitation_scope_invalid when an offered project left the workspace; invitation_pending when a concurrent invitation already owns the address; smtp_unconfigured when SMTP is missing; and smtp_password_unreadable when the stored password cannot be read. Answers 502 smtp_unreachable, smtp_auth_failed, smtp_tls_failed, or smtp_send_failed when the relay refuses the message.",
  request: { params: invitationParams },
  responses: {
    200: {
      description: "The new pending invitation, with its delivery recorded",
      content: { "application/json": { schema: InvitationSummary } },
    },
    400: problem("The workspace or invitation id is invalid"),
    401: problem("Not signed in"),
    403: problem(
      "Not an owner or delegated inviter, the inviter's email is unverified, or a delegate does not Manage an offered project",
    ),
    404: problem("No accessible shared workspace or invitation"),
    409: problem(
      "The invitation is accepted, declined, or revoked; an offered project left the workspace; the recipient is already a member; another invitation is pending; or SMTP is not configured or its stored password is unreadable",
    ),
    502: problem("The SMTP server refused the message; the code says why"),
  },
});

const revokeWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/invitations/{invitationId}/revoke",
  summary: "Revoke a workspace invitation",
  description:
    "Owners and delegated inviters. Only a pending, unexpired invitation is revoked; the link stops working and the row keeps its history and revocation timestamp. A delegate cannot revoke an offer containing a project they do not Manage.",
  request: { params: invitationParams },
  responses: {
    200: {
      description: "The revoked invitation",
      content: { "application/json": { schema: InvitationSummary } },
    },
    400: problem("The workspace or invitation id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner or delegated inviter of this workspace"),
    404: problem("No accessible shared workspace or invitation"),
    409: problem("The invitation is no longer pending and unexpired"),
  },
});

const declineWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspace-invitations/decline",
  summary: "Decline a workspace invitation",
  description:
    "The recipient declines from the emailed link. Holding the token is the capability; only a pending, unexpired invitation without failed delivery changes, and its link then stops working.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: DeclineWorkspaceInvitationRequest } },
    },
  },
  responses: {
    204: { description: "The invitation was declined" },
    400: problem("The token is invalid, expired, or already used"),
  },
});

const previewWorkspaceInvitation = createRoute({
  method: "get",
  path: "/api/workspace-invitations/preview",
  summary: "The workspace and address a workspace invitation link offers",
  description:
    "A read-only preview of a single-use invitation token. It never consumes the token and changes nothing. It returns the workspace, invited address, inviter, whether an account already exists for that address, deadline, and the actual offered grants, including every project and level. Invalid, expired, used, or failed-delivery links answer the same Problem. An offer whose project left the workspace answers 409 invitation_scope_invalid without returning project metadata.",
  request: { query: previewQuery },
  responses: {
    200: {
      description: "The invitation's workspace and invited address",
      content: { "application/json": { schema: WorkspaceInvitationPreview } },
    },
    400: problem("The token is invalid, expired, or already used"),
    409: problem("An offered project no longer belongs to the workspace"),
  },
});

const acceptWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspace-invitations/acceptance",
  summary: "Accept a workspace invitation as an existing account",
  description:
    "Redeems the emailed token for the signed-in account. The account's verified email must equal the invited address; a forwarded link cannot attach the membership to another account. Every offered project is rechecked against the workspace and the project grants are applied in the same transaction. The token is consumed only by this POST.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AcceptWorkspaceInvitationRequest } },
    },
  },
  responses: {
    200: {
      description: "The workspace, now a membership of the signed-in account",
      content: { "application/json": { schema: Workspace } },
    },
    400: problem("The token is invalid, expired, or already used"),
    401: problem("Not signed in"),
    403: problem(
      "The signed-in account is deactivated, has a different or unverified email, or the inviter no longer has authority",
    ),
    409: problem(
      "The account is already a member, an offered project left the workspace, or the workspace has no active owner yet",
    ),
  },
});

const registerThroughWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspace-invitations/registration",
  summary: "Register a new account through a workspace invitation",
  description:
    "Redeems the token for an address with no account, creating the account, its personal workspace, the verified-email mark, the workspace membership, and the offered project grants in one transaction. Every offered project must still belong to the workspace. An existing account answers account_exists and signs in to accept instead.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: RegisterThroughWorkspaceInvitationRequest },
      },
    },
  },
  responses: {
    200: {
      description: "The account, with its email verified and the membership created",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: problem("The token is invalid, expired, or already used"),
    403: problem("The inviter no longer has authority to invite to this workspace"),
    409: problem(
      "The invited email already has an account, or an offered project no longer belongs to the workspace",
    ),
  },
});

const appointWorkspaceOwner = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/owners",
  summary: "Appoint a member as another owner",
  description:
    "Owners only. The target must already be a member; an existing owner is returned unchanged.",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: { "application/json": { schema: AppointWorkspaceOwnerRequest } },
    },
  },
  responses: {
    200: {
      description: "The member, now an owner",
      content: { "application/json": { schema: WorkspaceMember } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner of this workspace"),
    404: problem("No accessible shared workspace or member"),
  },
});

const updateWorkspaceMember = createRoute({
  method: "patch",
  path: "/api/workspaces/{workspaceId}/members/{humanId}",
  summary: "Grant or revoke a member's workspace capabilities",
  description:
    "Grant or revoke Create projects, Invite members, Remove members, and Manage member permissions independently; at least one field is required. Owners may change any capability on any non-owner. A permission manager may change only capabilities they hold themselves, on someone else, and may never appoint or remove a permission manager. An owner's capabilities are implicit: setting one true is a no-op and setting one false is refused. A non-member answers 404 like a missing workspace. Each real change records an attributed event. Create projects never grants access to an existing project, and Project Manage grants no workspace capability.",
  request: {
    params: memberParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWorkspaceMemberRequest } },
    },
  },
  responses: {
    200: {
      description: "The member with its effective capabilities",
      content: { "application/json": { schema: WorkspaceMember } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller lacks the authority to change this member's capabilities"),
    404: problem("No accessible shared workspace or member"),
    409: problem("Workspace owners always hold every capability"),
  },
});

const removeWorkspaceMember = createRoute({
  method: "delete",
  path: "/api/workspaces/{workspaceId}/members/{humanId}",
  summary: "Remove a member from a shared workspace",
  description:
    "Owners, and members holding Remove members. A delegated remover cannot remove an owner or a permission manager, even themselves; owners may remove either but not the last owner. The removed human keeps their personal workspace and every other membership.",
  request: { params: memberParams },
  responses: {
    204: { description: "The membership was removed" },
    400: problem("The workspace or member id is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller lacks removal authority, or the target is protected"),
    404: problem("No accessible shared workspace or member"),
    409: problem("Removing this owner would leave the workspace with no owner"),
  },
});

const leaveWorkspace = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/leave",
  summary: "Leave a shared workspace voluntarily",
  description:
    "A member ends their own membership, with the same immediate key revocation, project-access cleanup, and active-claim release as a removal, but records a leave event. A personal workspace cannot be left, and the last owner of a shared workspace cannot leave: appoint another owner first. The caller's personal work and every other membership stay intact.",
  request: { params: workspaceParams },
  responses: {
    204: { description: "The membership was ended" },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    404: problem("No accessible shared workspace"),
    409: problem("The caller is the last owner of the workspace"),
  },
});

export const routes = [
  listWorkspaces,
  getWorkspace,
  listWorkspaceMembers,
  suggestHumans,
  createWorkspace,
  inviteWorkspaceMember,
  listWorkspaceInvitations,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  declineWorkspaceInvitation,
  previewWorkspaceInvitation,
  acceptWorkspaceInvitation,
  registerThroughWorkspaceInvitation,
  appointWorkspaceOwner,
  updateWorkspaceMember,
  removeWorkspaceMember,
  leaveWorkspace,
];

const statusFor = {
  not_signed_in: 401,
  workspace_not_found: 404,
  not_workspace_owner: 403,
  inviter_unverified: 403,
  inviter_not_authorized: 403,
  invitation_invalid: 400,
  invitation_recipient_mismatch: 403,
  email_unverified: 403,
  invitation_pending: 409,
  invitation_not_found: 404,
  invitation_not_pending: 409,
  invitation_scope_invalid: 409,
  already_member: 409,
  account_exists: 409,
  member_not_found: 404,
  last_owner: 409,
  workspace_owner_capability: 409,
  account_deactivated: 403,
  ownerless_workspace: 409,
} as const satisfies Record<WorkspacesErrorKind, number>;

function isKind<K extends readonly WorkspacesErrorKind[]>(
  error: WorkspacesError,
  kinds: K,
): error is WorkspacesError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const listKinds = ["not_signed_in"] as const;
const getKinds = ["not_signed_in", "workspace_not_found"] as const;
const membersKinds = ["not_signed_in", "workspace_not_found", "not_workspace_owner"] as const;
const suggestKinds = ["not_signed_in", "workspace_not_found", "not_workspace_owner"] as const;
const createKinds = ["not_signed_in"] as const;
const inviteKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "inviter_unverified",
  "already_member",
  "invitation_pending",
  "invitation_scope_invalid",
] as const;
const listInvitationKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
] as const;
const resendKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "inviter_unverified",
  "invitation_not_found",
  "invitation_not_pending",
  "invitation_pending",
  "invitation_scope_invalid",
  "already_member",
] as const;
const revokeKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "invitation_not_found",
  "invitation_not_pending",
] as const;
const declineKinds = ["invitation_invalid"] as const;
const previewKinds = ["invitation_invalid", "invitation_scope_invalid"] as const;
const acceptKinds = [
  "not_signed_in",
  "account_deactivated",
  "invitation_invalid",
  "inviter_not_authorized",
  "invitation_recipient_mismatch",
  "email_unverified",
  "already_member",
  "invitation_scope_invalid",
  "ownerless_workspace",
] as const;
const registerKinds = [
  "invitation_invalid",
  "inviter_not_authorized",
  "account_exists",
  "invitation_scope_invalid",
] as const;
const appointKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "member_not_found",
] as const;
const updateMemberKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "member_not_found",
  "workspace_owner_capability",
] as const;
const removeKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "member_not_found",
  "last_owner",
] as const;
const leaveKinds = ["not_signed_in", "workspace_not_found", "last_owner"] as const;

function failure<K extends readonly WorkspacesErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof WorkspacesError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

function sendFailure<K extends readonly WorkspacesErrorKind[]>(
  c: Context,
  error: unknown,
  kinds: K,
) {
  if (error instanceof WorkspacesError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  const delivery = deliveryProblem(c, error);
  if (delivery !== undefined) return delivery;
  throw error;
}

export function createWorkspacesRest(service: WorkspacesService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(listWorkspaces, async (c) => {
    try {
      return c.json(await service.list(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error, listKinds);
    }
  });

  app.openapi(getWorkspace, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.get(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, getKinds);
    }
  });

  app.openapi(listWorkspaceMembers, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.members(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, membersKinds);
    }
  });

  app.openapi(suggestHumans, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { q } = c.req.valid("query");
      return c.json(await service.suggestHumans(await sessionReader(c), workspaceId, q), 200);
    } catch (error) {
      return failure(c, error, suggestKinds);
    }
  });

  app.openapi(createWorkspace, async (c) => {
    try {
      return c.json(await service.create(await sessionReader(c), c.req.valid("json")), 201);
    } catch (error) {
      return failure(c, error, createKinds);
    }
  });

  app.openapi(inviteWorkspaceMember, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        await service.invite(await sessionReader(c), workspaceId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return sendFailure(c, error, inviteKinds);
    }
  });

  app.openapi(listWorkspaceInvitations, async (c) => {
    try {
      return c.json(
        await service.invitations(await sessionReader(c), c.req.valid("param").workspaceId),
        200,
      );
    } catch (error) {
      return failure(c, error, listInvitationKinds);
    }
  });

  app.openapi(resendWorkspaceInvitation, async (c) => {
    try {
      const { workspaceId, invitationId } = c.req.valid("param");
      return c.json(
        await service.resendInvitation(await sessionReader(c), workspaceId, invitationId),
        200,
      );
    } catch (error) {
      return sendFailure(c, error, resendKinds);
    }
  });

  app.openapi(revokeWorkspaceInvitation, async (c) => {
    try {
      const { workspaceId, invitationId } = c.req.valid("param");
      return c.json(
        await service.revokeInvitation(await sessionReader(c), workspaceId, invitationId),
        200,
      );
    } catch (error) {
      return failure(c, error, revokeKinds);
    }
  });

  app.openapi(declineWorkspaceInvitation, async (c) => {
    try {
      await service.declineInvitation(c.req.valid("json"));
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, declineKinds);
    }
  });

  app.openapi(previewWorkspaceInvitation, async (c) => {
    try {
      return c.json(await service.previewInvitation(c.req.valid("query").token), 200);
    } catch (error) {
      return failure(c, error, previewKinds);
    }
  });

  app.openapi(acceptWorkspaceInvitation, async (c) => {
    try {
      return c.json(
        await service.acceptInvitation(await sessionReader(c), c.req.valid("json").token),
        200,
      );
    } catch (error) {
      return failure(c, error, acceptKinds);
    }
  });

  app.openapi(registerThroughWorkspaceInvitation, async (c) => {
    try {
      return c.json(await service.registerThroughInvitation(c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error, registerKinds);
    }
  });

  app.openapi(appointWorkspaceOwner, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        await service.appointOwner(
          await sessionReader(c),
          workspaceId,
          c.req.valid("json").humanId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, appointKinds);
    }
  });

  app.openapi(updateWorkspaceMember, async (c) => {
    try {
      const { workspaceId, humanId } = c.req.valid("param");
      return c.json(
        await service.updateMemberCapability(
          await sessionReader(c),
          workspaceId,
          humanId,
          c.req.valid("json"),
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, updateMemberKinds);
    }
  });

  app.openapi(removeWorkspaceMember, async (c) => {
    try {
      const { workspaceId, humanId } = c.req.valid("param");
      await service.removeMember(await sessionReader(c), workspaceId, humanId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, removeKinds);
    }
  });

  app.openapi(leaveWorkspace, async (c) => {
    try {
      await service.leaveWorkspace(await sessionReader(c), c.req.valid("param").workspaceId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, leaveKinds);
    }
  });

  return app;
}
