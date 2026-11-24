#!/usr/bin/env python3
"""
Orrery Formal Verification Model Checker (M1-M36).

Extracts critical concurrency, locking, and state-transition guards directly from
Orrery's server source and SQL migrations, then runs an exhaustive BFS finite-state
model checker over each subsystem to verify safety and liveness invariants.

Usage:
  python3 .agents/skills/formal-verify-orrery/scripts/verify.py
  python3 .agents/skills/formal-verify-orrery/scripts/verify.py --json
"""

from collections import deque
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[4]


@dataclass
class CheckResult:
    id: str
    model: str
    property_name: str
    kind: str  # "safety" | "liveness"
    status: str  # "verified" | "violated"
    states_explored: int
    transitions_explored: int
    summary: str
    counterexample: list[str]
    files: list[str]


def read_text(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def slice_between(text: str, start_marker: str, end_marker: str | None = None) -> str:
    idx = text.find(start_marker)
    if idx == -1:
        return ""
    sub = text[idx:]
    if end_marker is not None:
        end_idx = sub.find(end_marker, len(start_marker))
        if end_idx == -1:
            return ""
        return sub[:end_idx]
    return sub


def extract_code_facts() -> dict[str, Any]:
    """Read real Orrery source files to determine which guards are currently active."""
    ws_src = read_text("apps/server/src/features/workspaces/service.ts")
    proj_src = read_text("apps/server/src/features/projects/service.ts")
    inv_src = read_text("apps/server/src/features/invitations/service.ts")
    acc_src = read_text("apps/server/src/features/accounts/service.ts")
    set_src = read_text("apps/server/src/features/settings/service.ts")
    # #32 history views: the scope decisions live in one service, the transport is thin,
    # and the response shape is the shared contract. All three are read so deleting a
    # guard flips the M13 attempts below to their wrong outcomes.
    hist_src = read_text("apps/server/src/features/history/service.ts")
    hist_rest = read_text("apps/server/src/features/history/rest.ts")
    hist_contract = read_text("packages/contract/src/history.ts")
    mig_0007 = read_text("db/migrations/0007_workspace_owner_guards.sql")
    mig_0008 = read_text("db/migrations/0008_workspace_ownership_write_order.sql")

    # #37: removal and voluntary leave share one private cleanup tail. M1, M8, M11 and M18
    # all inspect it, so define it once here rather than repeating the slice below.
    end_membership_fn = slice_between(ws_src, "async function endMembership(", "\n  }\n\n  return {")

    # M1: Workspace ownership serialization + deferred trigger
    remove_member_fn = slice_between(ws_src, "async removeMember(", "  };")
    m1_lock_in_service = "lockWorkspaceForMutation(tx, workspaceId)" in remove_member_fn
    m1_last_owner_check = 'throw new WorkspacesError("last_owner")' in remove_member_fn
    m1_db_advisory_lock = "pg_advisory_xact_lock(61683814, 24)" in mig_0008
    m1_db_trigger = "ensure_shared_workspace_has_owner()" in mig_0007

    # M2a: Replacing a failed, still-live invitation revokes it rather than expiring it.
    invite_fn = slice_between(ws_src, "async invite(", "async invitations(account, workspaceId)")
    revoke_failed = slice_between(invite_fn, "status: InvitationStatus.enum.revoked", "await tx.insert(workspaceInvitations)")
    m2a_supersedes_failed = (
        "InvitationDelivery.enum.failed" in revoke_failed
        and "revokedAt" in revoke_failed
        and "gt(workspaceInvitations.expiresAt" in revoke_failed
    )

    # M2b: recordDelivery guarded by status='pending' in both workspaces and invitations
    ws_record_delivery = slice_between(ws_src, "async function recordDelivery(", "async function redeemWorkspaceInvitation(")
    inv_record_delivery = slice_between(inv_src, "async function recordDelivery(", "export interface InvitationsServiceDeps")
    m2b_ws_guarded = "eq(workspaceInvitations.status, InvitationStatus.enum.pending)" in ws_record_delivery
    m2b_inv_guarded = "eq(invitations.status, InvitationStatus.enum.pending)" in inv_record_delivery

    # #33 (agent project work through MCP) reads its own transport, contract, and schema
    # sources so removing a guard or registering an admin tool flips the model below.
    mcp_src = read_text("apps/server/src/features/projects/mcp.ts")
    tools_src = read_text("packages/contract/src/mcp-tools.ts")
    proj_rest_src = read_text("apps/server/src/features/projects/rest.ts")
    mig_0017 = read_text("db/migrations/0017_rapid_talon.sql")

    # M3: Installation invite checks emailRegistered inside TX under per-email lock shared with createInvitedHuman
    inv_install_fn = slice_between(inv_src, "async inviteInstallation(", "async registerInstallation(")
    inv_tx_body = slice_between(inv_install_fn, "await db.transaction(async (tx) =>", "} catch (error)")
    create_invited_fn = slice_between(acc_src, "async createInvitedHuman(", "async emailRegistered(")
    m3_email_check_in_tx = "await emailRegistered(input.email, tx)" in inv_tx_body
    m3_per_email_lock = (
        "pg_advisory_xact_lock(61683815" in inv_tx_body
        and "pg_advisory_xact_lock(61683815" in create_invited_fn
    )

    install_resend = slice_between(inv_src, "async resendInstallation(", "async revokeInstallation(")
    install_registration = inv_src.split("async registerInstallation(", 1)[1]
    def ordered(source, *markers):
        offset = 0
        for marker in markers:
            offset = source.find(marker, offset)
            if offset < 0:
                return False
            offset += len(marker)
        return True

    m3_resend_serialized = (
        m3_per_email_lock
        and ordered(install_resend, "pg_advisory_xact_lock(61683815", '.for("update")', "await emailRegistered(row.email, tx)", "insert(invitations)")
        and ordered(install_registration, "pg_advisory_xact_lock(61683815", ".update(invitations)", "await createInvitedHuman(")
    )

    # M4: Project updateIssue & updateKnowledge acquire FOR UPDATE before requireIssue / requireKnowledge
    update_issue_fn = slice_between(proj_src, "async updateIssue(", "async listComments(")
    update_knowledge_fn = slice_between(proj_src, "async updateKnowledge(", "  };")
    m4_issue_for_update = bool(
        re.search(r'\.for\("update"\)[\s\S]*await requireIssue\(', update_issue_fn)
    )
    m4_knowledge_for_update = bool(
        re.search(r'\.for\("update"\)[\s\S]*await requireKnowledge\(', update_knowledge_fn)
    )

    # M5: sendTestEmail inserts before sendMail and retires older tokens only after sendMail succeeds
    send_test_fn = slice_between(set_src, "async sendTestEmail(", "async verifyEmail(")
    before_send = slice_between(send_test_fn, "async sendTestEmail(", "await sendMail(")
    after_send = slice_between(send_test_fn, "await sendMail(", "return {")
    m5_no_predelete = ".delete(emailVerificationTokens)" not in before_send
    m5_post_retire_guarded = (
        "stillPresent === undefined" in after_send
        and "ne(emailVerificationTokens.id, tokenId)" in after_send
    )

    # M6: Bootstrap singleton relies on instance_setup primary key inside transaction
    setup_admin_fn = slice_between(acc_src, "async setupAdmin(", "async login(")
    m6_singleton_tx = (
        "await db.transaction(async (tx) =>" in setup_admin_fn
        and "tx.insert(instanceSetup)" in setup_admin_fn
        and '"instance_setup_pkey"' in setup_admin_fn
    )

    # M7: every shared-workspace endpoint must resolve the actor through readMembership
    # with missingKind="workspace_not_found" (or through requireOwner, which does the same)
    # before deciding anything else. A missing target still answers member_not_found, but
    # a missing actor must never distinguish an existing workspace from a missing one.
    read_membership_fn = slice_between(ws_src, "async function readMembership(", "async function requireOwner(")
    require_owner_fn = slice_between(ws_src, "async function requireOwner(", "async function requireProjectManageScope(")
    m7_read_membership_404 = (
        "throw new WorkspacesError(missingKind)" in read_membership_fn
        and '"workspace_not_found" | "member_not_found" | "inviter_not_authorized"' in read_membership_fn
    )
    m7_require_owner_404 = bool(
        re.search(
            r'readMembership\(\s*tx,\s*workspaceId,\s*humanId,\s*"workspace_not_found"\s*,?\s*\)',
            require_owner_fn,
        )
    ) and bool(
        re.search(
            r'if \(!membership\.isOwner\) throw new WorkspacesError\("not_workspace_owner"\)',
            require_owner_fn,
        )
    )

    def actor_lookup_is_not_found(source: str) -> bool:
        return bool(
            re.search(
                r'readMembership\(\s*tx,\s*workspaceId,\s*actor\.humanId,\s*"workspace_not_found"\s*,?\s*\)',
                source,
            )
        )

    # The invitation-management endpoints share requireInviter(), which performs the same
    # non-enumerating actor lookup. Check both the helper and that each endpoint calls it.
    require_inviter_fn = slice_between(ws_src, "async function requireInviter(", "async function requireProjectManageScope(")
    m7_require_inviter_404 = bool(
        re.search(
            r'readMembership\(\s*tx,\s*workspaceId,\s*humanId,\s*"workspace_not_found"\s*,?\s*\)',
            require_inviter_fn,
        )
    ) and bool(
        re.search(
            r'if \(!inviter\.isOwner && !inviter\.canInviteMembers\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            require_inviter_fn,
        )
    )

    def inviter_lookup_is_not_found(source: str) -> bool:
        return (
            "await requireInviter(tx, workspaceId, actor.humanId)" in source
            or actor_lookup_is_not_found(source)
        )

    members_fn = slice_between(ws_src, "async members(account, workspaceId) {", "async create(account, input) {")
    get_fn = slice_between(ws_src, "async get(account, workspaceId) {", "async members(account, workspaceId) {")
    invitations_fn = slice_between(ws_src, "async invitations(account, workspaceId) {", "async resendInvitation(")
    resend_fn = slice_between(ws_src, "async resendInvitation(", "async revokeInvitation(")
    revoke_fn = slice_between(ws_src, "async revokeInvitation(", "async declineInvitation(")
    appoint_fn = slice_between(ws_src, "async appointOwner(", "async updateMemberCapability(")
    update_member_fn = slice_between(ws_src, "async updateMemberCapability(", "async removeMember(")
    m7_get_404 = (
        'throw new WorkspacesError("workspace_not_found")' in get_fn
        and "eq(workspaceMemberships.humanId, account.humanId)" in get_fn
    )
    m7_endpoint_reads = {
        "GET /api/workspaces/:id/members": actor_lookup_is_not_found(members_fn),
        "POST /api/workspaces/:id/invitations": inviter_lookup_is_not_found(invite_fn),
        "GET /api/workspaces/:id/invitations": inviter_lookup_is_not_found(invitations_fn),
        "POST /api/workspaces/:id/invitations/:id/resend": inviter_lookup_is_not_found(resend_fn),
        "POST /api/workspaces/:id/invitations/:id/revoke": inviter_lookup_is_not_found(revoke_fn),
        "POST /api/workspaces/:id/owners": (
            "await requireOwner(tx, workspaceId, actor.humanId)" in appoint_fn
        ),
        "PATCH /api/workspaces/:id/members/:humanId": actor_lookup_is_not_found(update_member_fn),
        "DELETE /api/workspaces/:id/members/:humanId": actor_lookup_is_not_found(remove_member_fn),
    }
    m7_non_member_404 = (
        m7_read_membership_404
        and m7_require_owner_404
        and m7_require_inviter_404
        and m7_get_404
        and all(m7_endpoint_reads.values())
    )

    # M8: Project access grants and creation serialize with workspace membership writes
    create_project_fn = slice_between(proj_src, "async createProject(", "async updateProject(")
    set_access_fn = slice_between(proj_src, "async setProjectAccess(", "async removeProjectAccess(")
    remove_access_fn = slice_between(proj_src, "async removeProjectAccess(", "revokeMemberProjectAccess(tx,")
    m8_access_serialized = (
        "lockWorkspaceOwnershipWrites(tx)" in create_project_fn
        and "lockWorkspaceOwnershipWrites(tx)" in set_access_fn
        and "lockWorkspaceOwnershipWrites(tx)" in remove_access_fn
        # #37 moved the grant revocation into the shared cleanup tail: the removal must
        # call that tail, and the tail must still revoke the departing member's grants.
        and "endMembership(" in remove_member_fn
        and "revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
    )

    # M9: These source markers select transitions in a bounded design model. They do
    # not prove transaction wiring or rollback; the real-Postgres tests exercise both.
    preview_fn = slice_between(ws_src, "async previewInvitation(", "async acceptInvitation(")
    accept_fn = slice_between(ws_src, "async acceptInvitation(", "async registerThroughInvitation(")
    register_fn = slice_between(ws_src, "async registerThroughInvitation(", "async appointOwner(")
    resend_fn = slice_between(ws_src, "async resendInvitation(", "async revokeInvitation(")
    apply_grants_fn = slice_between(
        proj_src,
        "async function applyInvitationGrantsInTransaction(",
        "async function lockWorkspaceOwnershipWrites",
    )
    m9_offer_persisted = "insert(workspaceInvitationGrants)" in invite_fn
    m9_existing_applies = (
        "await applyInvitationGrants(" in accept_fn
        and 'WorkspacesError("invitation_scope_invalid")' in accept_fn
    )
    m9_registration_applies = (
        "await applyInvitationGrants(" in register_fn
        and 'WorkspacesError("invitation_scope_invalid")' in register_fn
    )
    m9_grant_writer = "insert(projectAccessGrants)" in apply_grants_fn
    m9_apply_validates = (
        "currentWorkspaceByProject.get(projectId) !== workspaceId" in apply_grants_fn
        and "if (invalid.length > 0) return invalid" in apply_grants_fn
    )
    m9_resend_copies = (
        "workspaceInvitationGrants" in resend_fn
        and "projectId: grant.projectId" in resend_fn
        and "insert(workspaceInvitationGrants)" in resend_fn
    )

    m9_resend_validates = (
        "requireOfferedProjectsInWorkspace(tx, workspaceId, offered)" in resend_fn.split(".update(workspaceInvitations)", 1)[0]
    )
    m9_preview_validates = (
        "loadOfferedProjectGrants(db, row.workspaceId, [row.id])" in preview_fn
        and "grant.projectName === null" in preview_fn
        and 'WorkspacesError("invitation_scope_invalid")' in preview_fn
    )

    # An owner whose offered project moved out of the workspace must no longer make the
    # address look live: inviterStillAuthorized checks the offered scope before its owner
    # early-return, so a fresh invite supersedes the dead offer instead of 409-ing.
    still_live_fn = slice_between(
        ws_src, "async function inviterStillAuthorized(", "function toWorkspace("
    )
    scope_check = still_live_fn.find("await offeredProjectsInWorkspace(tx, workspaceId, offered)")
    owner_return = still_live_fn.find("if (inviter.isOwner) return true")
    m9_owner_stale_supersedes = (
        scope_check >= 0
        and owner_return >= 0
        and scope_check < owner_return
        and "eq(projects.workspaceId, workspaceId)" in slice_between(
            ws_src, "async function offeredProjectsInWorkspace(", "async function requireOfferedProjectsInWorkspace("
        )
    )

    # M10: #28 delegation ceilings and the inviter's authority at redemption. Each guard
    # is scoped to the function that owns the decision; a check in another endpoint does
    # not satisfy it.
    revoke_fn = slice_between(ws_src, "async revokeInvitation(", "async declineInvitation(")
    redeem_fn = slice_between(ws_src, "async function redeemWorkspaceInvitation(", "async function requireRecipientNotMember(")
    require_project_manage_fn = slice_between(ws_src, "async function requireProjectManageScope(", "async function requireVerifiedInviter(")
    still_authorized_fn = slice_between(ws_src, "async function requireInviterStillAuthorized(", "async function loadManagedProjectIds(")
    m10_owner_only_manager = bool(
        re.search(
            r'if \(requested\.canManageMemberPermissions !== undefined\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_no_owner_modify = bool(
        re.search(
            r'if \(member\.isOwner\) \{\s*if \(!actorMembership\.isOwner\) throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_no_self_modify = bool(
        re.search(
            r'if \(actorMembership\.humanId === humanId\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_capability_ceiling = bool(
        re.search(
            r'if \(requested\[capability\] !== undefined && !actorMembership\[capability\]\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_remove_authority = bool(
        re.search(
            r'if \(!actorMembership\.isOwner && !actorMembership\.canRemoveMembers\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            remove_member_fn,
        )
    )
    m10_remove_protected = bool(
        re.search(
            r'if \(!actorMembership\.isOwner && \(target\.isOwner \|\| target\.canManageMemberPermissions\)\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            remove_member_fn,
        )
    )
    m10_project_manage_guard = (
        "eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage)" in require_project_manage_fn
        and "eq(projects.workspaceId, workspaceId)" in require_project_manage_fn
        and "if (ids.some((id) => !managed.has(id))) throw new WorkspacesError(deniedKind)"
        in require_project_manage_fn
    )

    def scoped_to_inviter(source: str) -> bool:
        return bool(
            re.search(r'await requireProjectManageScope\([\s\S]*?"not_workspace_owner"', source)
        )

    m10_invite_scope = scoped_to_inviter(invite_fn)
    m10_resend_scope = scoped_to_inviter(resend_fn)
    m10_revoke_scope = scoped_to_inviter(revoke_fn)
    m10_redemption_membership = bool(
        re.search(
            r'readMembership\(\s*tx,\s*workspaceId,\s*inviterHumanId,\s*"inviter_not_authorized"\s*,?\s*\)',
            still_authorized_fn,
        )
    )
    m10_redemption_capability = bool(
        re.search(
            r'if \(!inviter\.isOwner && !inviter\.canInviteMembers\) \{\s*throw new WorkspacesError\("inviter_not_authorized"\)',
            still_authorized_fn,
        )
    )
    m10_redemption_verified = (
        'if (inviter.emailVerifiedAt === null) throw new WorkspacesError("inviter_not_authorized")'
        in still_authorized_fn
    )
    m10_redemption_project_scope = bool(
        re.search(
            r'await requireProjectManageScope\(tx, workspaceId, inviter, offered, "inviter_not_authorized"\)',
            still_authorized_fn,
        )
    )
    m10_redeem_checks_inviter = bool(
        re.search(r'await requireInviterStillAuthorized\([\s\S]*?\boffered\b', redeem_fn)
    )
    m10_accept_redeems = "await redeemWorkspaceInvitation(tx, token)" in accept_fn
    m10_register_redeems = "await redeemWorkspaceInvitation(tx, input.token)" in register_fn
    # #28 review fixes: a delegate's history is scoped to projects they Manage, a dead
    # pending offer cannot block an address, and an inviter may always revoke their own.
    m10_list_scoping = (
        "await loadManagedProjectIds(tx, workspaceId, actor.humanId)" in invitations_fn
        and "offered.every((grant) => managed.has(grant.projectId))" in invitations_fn
    )
    m10_dead_offer_supersedes = (
        "await inviterStillAuthorized(" in invite_fn
        and "eq(workspaceInvitations.id, blocking.id)" in invite_fn
    )
    m10_self_revoke = "if (row.invitedByHumanId !== actor.humanId)" in revoke_fn

    # M11 (#30): workspace-scoped agent API keys. Each guard is extracted from the
    # function that owns the decision, so removing one produces a short counterexample
    # naming the exact API path and TS function instead of a generic model failure.
    ag_src = read_text("apps/server/src/features/agents/service.ts")
    ag_schema = read_text("apps/server/src/db/schema.ts")
    resolve_fn = slice_between(
        ag_src, "async function resolveKeyInTransaction(", "export function createAgentsService"
    )
    issue_fn = slice_between(ag_src, "async issueKey(", "async listKeys(")
    revoke_own_fn = slice_between(ag_src, "async function revokeInTransaction(", "export async function revokeMemberWorkspaceKeys(")
    revoke_member_fn = slice_between(
        ag_src, "export async function revokeMemberWorkspaceKeys(", "async function resolveKeyInTransaction("
    )
    authenticate_fn = slice_between(ag_src, "async authenticate(", "  };")
    record_fn = slice_between(ag_src, "async function recordEvent(", "type KeyRow")
    owner_fn = slice_between(ag_src, "async ownerRevokeKey(", "async authenticate(")
    events_table = slice_between(ag_schema, "export const agentKeyEvents = pgTable(", "export const runs = pgTable(")
    mig_0018 = read_text("db/migrations/0018_agent_key_project_scope.sql")

    # Removal revokes the member's workspace keys in the removal's own transaction, with
    # one secret-free event per newly revoked key; issuance takes the ownership lock so
    # no INSERT can land after that revocation. Authentication reads one REPEATABLE READ
    # snapshot, and the database rejects a key grant outside the key's workspace.
    m11_member_removal_revokes_keys = (
        # #37: removeMember delegates the cleanup to endMembership; both the call and the
        # key revocation inside the tail must be present for a rejoin to stay revoked.
        "endMembership(" in remove_member_fn
        and "revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
        and "revokedAt: sql`now()`" in revoke_member_fn
        and "isNull(agentApiKeys.revokedAt)" in revoke_member_fn
        and "AgentKeyEventType.enum.agent_key_revoked" in revoke_member_fn
    )
    m11_issue_serialized = "await lockWorkspaceOwnershipWrites(tx)" in issue_fn.split(
        "const [agent]", 1
    )[0]
    m11_repeatable_read_auth = (
        'isolationLevel: "repeatable read"' in authenticate_fn
        and 'accessMode: "read only"' in authenticate_fn
    )
    m11_key_project_scope_db = (
        "CREATE TRIGGER agent_key_project_scope\n" in mig_0018
        and "BEFORE INSERT OR UPDATE ON agent_api_key_projects" in mig_0018
        and "key_workspace <> project_workspace" in mig_0018
        and "RAISE EXCEPTION" in mig_0018
    )

    m11_revocation = (
        "row.key.revokedAt !== null" in resolve_fn
        and 'throw new AgentsError("key_revoked")' in resolve_fn
        and "revokedAt: sql`now()`" in revoke_own_fn
    )
    m11_membership = (
        "humanCanUseWorkspace(tx, row.key.workspaceId, row.humanId)" in resolve_fn
        and 'throw new AgentsError("key_workspace_inaccessible")' in resolve_fn
    )
    m11_expiry = (
        "gt(agentApiKeys.expiresAt, sql`now()`)" in resolve_fn
        and 'throw new AgentsError("key_expired")' in resolve_fn
    )
    expiry_block = slice_between(
        resolve_fn,
        "if (AgentKeyValidity.parse(row.key.validity) !== AgentKeyValidity.enum.never)",
        "if (target?.workspaceId !== undefined",
    )
    m11_never_skips_expiry_only = (
        "gt(agentApiKeys.expiresAt" in expiry_block
        and "row.key.revokedAt" not in expiry_block
        and "humanCanUseWorkspace" not in expiry_block
        and "projectAccessCeiling(" not in expiry_block
    )
    m11_scope = (
        "target.workspaceId !== row.key.workspaceId" in resolve_fn
        and 'throw new AgentsError("key_out_of_scope")' in resolve_fn
    )
    m11_project_scope = (
        "effective.some((grant) => grant.projectId === target.projectId)" in resolve_fn
        and 'throw new AgentsError("insufficient_agent_access")' in resolve_fn
    )
    m11_ceiling = bool(
        re.search(r"projectAccessCeiling\(", resolve_fn)
        and re.search(
            r"projectAccessAtLeast\(humanLevel,\s*grant\.level\)\s*\?\s*grant\.level\s*:\s*humanLevel",
            resolve_fn,
        )
    )
    m11_issue_ceiling = bool(
        re.search(r"!projectAccessAtLeast\(humanLevel,\s*grant\.level\)", issue_fn)
        and 'throw new AgentsError("invalid_key_grant")' in issue_fn
    )
    m11_single_event = (
        ".returning({ id: agentApiKeys.id })" in revoke_own_fn
        and "if (updated.length > 0)" in revoke_own_fn
        and "recordEvent(" in revoke_own_fn
    )
    m11_owner_isolation = (
        "requireWorkspaceOwner(tx, workspaceId, actor.humanId)" in owner_fn
        and "eq(agentApiKeys.workspaceId, workspaceId)" in owner_fn
    )
    m11_key_hash_only = (
        "tokenHash: tokenHash(secret)" in issue_fn
        and "secret:" not in slice_between(issue_fn, ".insert(agentApiKeys)", ".returning(")
    )
    m11_events = (
        "insert(agentKeyEvents)" in record_fn
        and "AgentKeyEventType.enum.agent_key_created" in issue_fn
        and "AgentKeyEventType.enum.agent_key_revoked" in revoke_own_fn
        and "recordEvent(" in revoke_own_fn
    )
    m11_events_without_secret = (
        "token_hash" not in events_table
        and "tokenHash:" not in events_table
        and "secret:" not in events_table
    )

    # M12 (#33): one policy path for REST and MCP, agent-attributed writes, and no
    # membership or installation administration reachable by an agent key.
    actor_level_fn = slice_between(proj_src, "function actorAccessLevel(", "function requireLevel(")
    m12_agent_scope = (
        "actor.identity.workspaceId" in actor_level_fn
        and "facts.workspaceId !== actor.identity.workspaceId" in actor_level_fn
        and "actor.identity.projects.find((grant) => grant.projectId === facts.projectId)" in actor_level_fn
    )
    m12_shared_gate = (
        "function requireLevel(" in proj_src
        and "actorAccessLevel(facts, actor)" in proj_src
        and all(
            f'requireLevel({arg}, actor, required, "{kind}")' in proj_src
            for arg, kind in [
                ("facts", "project_not_found"),
                ("row", "issue_not_found"),
                ("row", "knowledge_entry_not_found"),
            ]
        )
    )
    record_activity_fn = slice_between(proj_src, "async function insertActivityRow(", "async function recordAccessEvent(")
    m12_agent_actor = (
        "actorHumanId: humanIdOf(input.actor)" in record_activity_fn
        and "actorAgentId: agentIdOf(input.actor)" in record_activity_fn
        and "humanIdOf(actor)" in proj_src
        and "agentIdOf(actor)" in proj_src
    )
    m12_actor_constraint = (
        "issues_created_by_actor" in mig_0017
        and "project_activity_actor" in mig_0017
        and "created_by_agent_id" in mig_0017
        and "actor_agent_id" in mig_0017
        and "actorHumanId: text(\"actor_human_id\").references(() => humans.id)" in ag_schema
        and "actorAgentId: text(\"actor_agent_id\").references(() => agents.id)" in ag_schema
    )
    list_projects_service = slice_between(proj_src, "async listProjects(", "async getProject(")
    m12_list_scope = (
        "actor.kind === \"agent\" && workspaceId !== actor.identity.workspaceId"
        in list_projects_service
        and 'throw new ProjectsError("workspace_not_found")' in list_projects_service
    )
    m12_mcp_reauth = (
        "await authenticate(request)" in mcp_src
        and 'kind: "agent"' in mcp_src
        and "tool.input.parse(rawArgs)" in mcp_src
    )
    tool_names = re.findall(r'name: "([a-z_]+)"', tools_src)
    m12_tools_exist = all(
        name in tool_names
        for name in [
            "list_projects", "list_issues", "create_issue", "update_issue", "create_comment",
            "list_activity", "list_knowledge", "create_knowledge", "update_knowledge",
        ]
    )
    m12_no_admin_tools = all(
        not any(word in name for word in ["member", "invit", "workspace", "access", "setting", "key", "admin", "grant"])
        for name in tool_names
    )
    list_projects_rest = slice_between(proj_rest_src, "app.openapi(listProjects,", "  });")
    create_project_rest = slice_between(proj_rest_src, "app.openapi(createProject,", "  });")
    set_access_rest = slice_between(proj_rest_src, "app.openapi(setProjectAccess,", "  });")
    m12_rest_bearer = (
        "await workActor(c)" in list_projects_rest
        and "agentAuthenticator(c.req.raw)" in proj_rest_src
        and 'if (identity !== null) return { kind: "agent", identity };' in proj_rest_src
        and "isAgentError(error)" in proj_rest_src
    )
    m12_rest_admin_session = (
        "await workActor(c)" not in create_project_rest
        and "await workActor(c)" not in set_access_rest
        and "await sessionReader(c)" in create_project_rest
        and "await sessionReader(c)" in set_access_rest
    )

    # M13: history visibility boundaries (#32). Each guard is read from the decision that
    # produces it: the three service methods, the installation projection, and the thin
    # REST adapter. A missing scope check or a leaked secret field flips an attempt below.
    hist_ws_fn = slice_between(hist_src, "async workspaceHistory(", "async projectHistory(")
    hist_proj_fn = slice_between(hist_src, "async projectHistory(", "async installationHistory(")
    hist_inst_fn = hist_src.split("async installationHistory(", 1)[1] if "async installationHistory(" in hist_src else ""
    hist_install_fn = slice_between(hist_src, "async function loadInstallationEvents(", "export interface HistoryDeps")
    hist_key_fn = slice_between(hist_src, "async function loadKeyEvents(", "async function loadProjectAccessEvents(")

    m13_session_only = (
        hist_rest.count("await sessionReader(c)") >= 3
        and "agentAuthenticator" not in hist_rest
        and "readBearerToken" not in hist_rest
    )
    m13_workspace_404 = (
        'throw new HistoryError("workspace_not_found")' in hist_ws_fn
        and "workspaceMemberships" in hist_ws_fn
    )
    m13_delegate_scope = (
        'throw new HistoryError("workspace_history_forbidden")' in hist_ws_fn
        and "row.canManageMemberPermissions !== true" in hist_ws_fn
        and "eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage)" in hist_ws_fn
    )
    m13_owner_keys = (
        "if (isOwner) {" in hist_ws_fn
        and "loadKeyEvents(" in hist_ws_fn
        and "loadKeyEvents(" not in hist_ws_fn.split("if (isOwner) {", 1)[0]
    )
    m13_project_404 = (
        'throw new HistoryError("project_not_found")' in hist_proj_fn
        and "ceiling.get(projectId)" in hist_proj_fn
    )
    m13_manage_access = "projectAccessAtLeast(level, ProjectAccessLevel.enum.manage)" in hist_proj_fn
    m13_activity_granted = ordered(
        hist_proj_fn, "const events = await loadProjectActivity(", "projectAccessAtLeast("
    )
    m13_admin_only = (
        "isSystemAdministrator" in hist_inst_fn
        and 'throw new HistoryError("not_system_administrator")' in hist_inst_fn
    )
    m13_installation_scope = (
        "from(instanceSetup)" in hist_install_fn
        and "from(invitations)" in hist_install_fn
        and not any(
            table in hist_install_fn
            for table in [
                "workspaceEvents", "projectAccessEvents", "projectActivity",
                "agentKeyEvents", "workspaceMemberships",
            ]
        )
    )
    m13_no_secret = not re.search(
        r"(secret|tokenHash|token_hash|passwordHash|password_hash|smtpPassword)\s*:",
        hist_contract + hist_key_fn + hist_install_fn,
    )
    # M14 (#34): runs and child workers. Identity is the authenticated agent plus the
    # harness's native session id, enforced by a partial unique index. The whole report
    # mutation runs in one transaction under a FOR UPDATE row lock, so concurrent model
    # reports cannot duplicate history or drop a child update. Reported metadata is
    # stored as reported (or null) and a report never leases.
    run_src = read_text("apps/server/src/features/runs/service.ts")
    run_mcp_src = read_text("apps/server/src/features/runs/mcp.ts")
    run_rest_src = read_text("apps/server/src/features/runs/rest.ts")
    run_contract_src = read_text("packages/contract/src/runs.ts")
    mig_0019 = read_text("db/migrations/0019_perpetual_wallop.sql")
    runs_table = slice_between(ag_schema, "export const runs = pgTable(", "export const runModelChanges = pgTable(")
    children_table = slice_between(ag_schema, "export const runChildren = pgTable(", "export const issues = pgTable(")
    report_fn = slice_between(run_src, "async report(identity, input)", "async listWorkspaceRuns(")
    list_runs_fn = slice_between(run_src, "async listWorkspaceRuns(", "  };\n}")
    child_fn = slice_between(run_src, "async function recordChild(", "export function createRunsService")

    m14_db_identity = (
        "one_run_per_agent_workspace_harness_session" in runs_table
        and "is not null and" in runs_table
        and "coalesce" not in runs_table
        and 'CREATE UNIQUE INDEX "one_run_per_agent_workspace_harness_session"' in mig_0019
        and "is not null and" in mig_0019
        and "coalesce" not in mig_0019
    )
    m14_identity_key = all(
        marker in report_fn
        for marker in [
            "agentId: identity.agentId",
            "workspaceId: identity.workspaceId",
            "harness: runKey.harness",
            "nativeSessionId: runKey.nativeSessionId",
        ]
    )
    m14_conflict = (
        ".onConflictDoNothing()" in report_fn
        and "eq(runs.harness, runKey.harness)" in report_fn
        and "eq(runs.nativeSessionId, runKey.nativeSessionId)" in report_fn
        and "row = created" in report_fn
    )
    m14_explicit_scope = all(
        marker in report_fn
        for marker in [
            "eq(runs.id, input.runId)",
            "eq(runs.agentId, identity.agentId)",
            "eq(runs.workspaceId, identity.workspaceId)",
            'throw new RunsError("run_not_found")',
        ]
    )
    m14_child_link = (
        "await recordChild(tx, identity, row.id, input, observedAt)" in report_fn
        and "childRunId," in child_fn
        and "agentId," in child_fn
        and "one_child_per_run_and_reported_identity" in children_table
        and "is not null or" in children_table
        and "one_child_per_run_and_reported_identity" in mig_0019
        and "is not null or" in mig_0019
        and 'FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE set null' in mig_0019
    )
    m14_child_scope = all(
        marker in child_fn
        for marker in [
            "childRunId === runId",
            "eq(runs.id, childRunId)",
            "eq(runs.agentId, identity.agentId)",
            "eq(runs.workspaceId, identity.workspaceId)",
            'throw new RunsError("run_not_found")',
            '.for("update")',
        ]
    )
    m14_serialized = (
        "db.transaction(async (tx)" in report_fn
        and 'const [locked]' in report_fn
        and 'previousModel = locked.model' in report_fn
        and '.for("update")' in report_fn
        and '.for("update")' in child_fn
    )
    m14_model_change = (
        "const modelChanged = reportedModel !== null && reportedModel !== previousModel;" in report_fn
        and "if (modelChanged && !inserted)" in report_fn
        and "fromModel: previousModel" in report_fn
        and "toModel: reportedModel" in report_fn
        and "insert(runModelChanges)" in report_fn
    )
    m14_unknown = (
        "const reportedModel = input.model ?? input.reported?.model ?? null" in report_fn
        and "runId: null," in report_fn
        and "harness: null," in report_fn
        and "harness: z.string().nullable()" in run_contract_src
        and "model: z.string().nullable()" in run_contract_src
        and "runId: z.string().nullable()" in run_contract_src
    )
    m14_reported_contract = (
        "reported:" in run_contract_src
        and "runKey: RunKey.nullable().optional()" in run_contract_src
        and "input.checkIn?.at" in report_fn
        and "input.reported?.harnessVersion" in report_fn
    )
    m14_no_lease = not any(
        word in source
        for word in ["leaseExpiresAt", "claimExpiresAt"]
        for source in [run_src, run_contract_src, run_mcp_src, mig_0019]
    )
    m14_human_scope = (
        "humanCanReadWorkspace(db, workspaceId, actor.humanId)" in list_runs_fn
        and "innerJoin(agents" in list_runs_fn
        and 'throw new RunsError("workspace_not_found")' in list_runs_fn
    )
    m14_adapters = (
        "report(identity: AgentIdentity | null, input: RunReportInput)" in run_src
        and "await authenticate(c.req.raw)" in run_rest_src
        and "await authenticate(request)" in run_mcp_src
        and "service.report(identity, c.req.valid(\"json\"))" in run_rest_src
        and "service.report(identity, parsed)" in run_mcp_src
        and "isAgentError(error)" in run_rest_src
        and "isAgentError(error)" in run_mcp_src
        and "Request" not in slice_between(run_src, "export interface RunsService", "type RunRow")
    )
    m14_tool = "orrery_run_checkin" in tool_names
    # M15 (#31): password reset and local recovery. Each guard is read from the
    # function or table that owns the decision, so deleting one produces a short
    # counterexample naming the exact API path and TS function.
    rec_src = read_text("apps/server/src/features/recovery/service.ts")
    rec_rest_src = read_text("apps/server/src/features/recovery/rest.ts")
    rec_cli_src = read_text("apps/server/src/recovery-cli.ts")
    rec_request_fn = slice_between(rec_src, "async requestReset(email)", "async confirmReset(token, password)")
    rec_confirm_fn = slice_between(rec_src, "async confirmReset(token, password)", "async localRecover(email, password)")
    rec_local_fn = slice_between(rec_src, "async localRecover(email, password)", "\n    },")
    rec_change_fn = slice_between(rec_src, "async function changePasswordAndSignOut(", "export function createRecoveryService")
    rec_tokens_table = slice_between(schema_src := read_text("apps/server/src/db/schema.ts"), "export const passwordResetTokens = pgTable(", "export const accountRecoveryEventTypes =")
    rec_events_table = slice_between(schema_src, "export const accountRecoveryEvents = pgTable(", "export const invitations = pgTable(")
    rec_token_insert = slice_between(rec_request_fn, ".insert(passwordResetTokens)", "try {")

    m15_token_hash_only = (
        "tokenHash: tokenHash(token)" in rec_token_insert
        and '"token_hash"' in rec_tokens_table
        and '"password"' not in rec_tokens_table
        and '"secret"' not in rec_tokens_table
    )
    verified_branch = rec_request_fn.find("account.emailVerifiedAt !== null")
    deliver_at = rec_request_fn.find("await deliver(")
    m15_unverified_no_mail = (
        verified_branch >= 0 and deliver_at > verified_branch
    )
    m15_uniform_response = (
        "return { message: PASSWORD_RESET_REQUEST_MESSAGE };" in rec_request_fn
        and "return { email:" not in rec_request_fn
        and "return { humanId:" not in rec_request_fn
    )
    m15_failed_send_deletes_token = (
        "await db.delete(passwordResetTokens)" in rec_request_fn
        and "catch (error)" in rec_request_fn
    )
    m15_single_use = (
        "isNull(passwordResetTokens.usedAt)" in rec_confirm_fn
        and 'throw new RecoveryError("reset_token_invalid")' in rec_confirm_fn
    )
    m15_db_time_expiry = "gt(passwordResetTokens.expiresAt, sql`now()`)" in rec_confirm_fn
    m15_one_tx = (
        "await db.transaction(async (tx) =>" in rec_confirm_fn
        and "changePasswordAndSignOut(" in rec_confirm_fn
        and "await db.transaction(async (tx) =>" in rec_local_fn
    )
    m15_sessions_cleared = (
        "invalidateBrowserSessions(humanId, tx)" in rec_change_fn
        and "await runner.delete(browserSessions)" in acc_src
    )
    m15_agent_keys_untouched = all(
        word not in rec_change_fn and word not in rec_cli_src
        for word in ("agentApiKeys", "agentKeyEvents", "agents)", "revokeAgent")
    )
    m15_scope_untouched = all(
        word not in rec_change_fn and word not in rec_local_fn and word not in rec_cli_src
        for word in ("instanceSetup", "workspaces", "workspaceMemberships", "setupAdmin", "appointOwner")
    )
    m15_events_without_secret = (
        "insert(accountRecoveryEvents)" in rec_change_fn
        and '"token_hash"' not in rec_events_table
        and '"password"' not in rec_events_table
        and '"secret"' not in rec_events_table
        and "tokenHash:" not in rec_change_fn
    )
    m15_local_no_smtp = (
        "deliver(" not in rec_local_fn
        and "localRecover(" in rec_cli_src
        and "local recovery never sends mail" in rec_cli_src
    )
    m15_http_problems = (
        rec_rest_src.count("400: problem(") >= 2
        and rec_rest_src.count("app.openapi(") >= 2
    )
    # A password change retires every outstanding link, and local recovery is an
    # administrator-only path: the role must come from accounts and be checked here.
    m15_revokes_pending_tokens = (
        ".update(passwordResetTokens)" in rec_change_fn
        and "isNull(passwordResetTokens.usedAt)" in rec_change_fn
    )
    account_by_email_fn = slice_between(acc_src, "export async function accountByEmail(", "export async function setAccountPasswordHash(")
    m15_admin_only_local = (
        "isSystemAdministrator: humans.isSystemAdministrator" in account_by_email_fn
        and "!account.isSystemAdministrator" in rec_local_fn
        and 'throw new RecoveryError("not_system_administrator")' in rec_local_fn
    )

    # M16 (#35): rotation. Each guard is read from the decision that owns it — the
    # service method, its thin REST route, the key tables, the migration, and the shared
    # contract — so deleting one flips the corresponding bounded attempt below.
    ag_rest = read_text("apps/server/src/features/agents/rest.ts")
    ag_contract = read_text("packages/contract/src/agents.ts")
    mig_0021 = read_text("db/migrations/0021_demonic_warstar.sql")
    rotate_fn = slice_between(ag_src, "async rotateKey(", "async listKeys(")
    rotate_prelude = rotate_fn.split("const [source]", 1)[0]
    source_select = slice_between(rotate_fn, "const [source] = await tx", ".limit(1)")
    rotate_insert = slice_between(rotate_fn, ".insert(agentApiKeys)", ".returning(")
    rotate_route = slice_between(ag_rest, "const rotateKey = createRoute(", "const listKeys = createRoute(")
    keys_table = slice_between(ag_schema, "export const agentApiKeys = pgTable(", "export const agentApiKeyProjects = pgTable(")

    m16_serialized = "await lockWorkspaceOwnershipWrites(tx)" in rotate_prelude
    m16_source_ownership = (
        "eq(agents.humanId, actor.humanId)" in source_select
        and 'throw new AgentsError("key_not_found")' in rotate_fn
    )
    m16_revoked_refused = (
        "source.key.revokedAt !== null" in rotate_fn
        and 'throw new AgentsError("source_key_revoked")' in rotate_fn
    )
    m16_expired_refused = (
        "gt(agentApiKeys.expiresAt, sql`now()`)" in rotate_fn
        and 'throw new AgentsError("source_key_expired")' in rotate_fn
    )
    m16_workspace_access = (
        "humanCanUseWorkspace(tx, source.key.workspaceId, actor.humanId)" in rotate_fn
        and 'throw new AgentsError("workspace_not_found")' in rotate_fn
    )
    m16_same_agent_workspace = (
        "agentId: source.key.agentId" in rotate_insert
        and "workspaceId: source.key.workspaceId" in rotate_insert
        and "replacesKeyId: keyId" in rotate_insert
    )
    m16_independent_secret = (
        "const secret = newSecret()" in rotate_fn
        and "tokenHash: tokenHash(secret)" in rotate_insert
        and "tokenHash" not in source_select
        and "secret:" not in rotate_insert
    )
    m16_independent_expiry = (
        "expiresAt: expiryFor(validity)" in rotate_insert
        and "now() + make_interval(days =>" in ag_src
        and "expiresAt: source" not in rotate_insert
    )
    m16_grants_capped = (
        "projectAccessCeiling(" in rotate_fn
        and "projectAccessAtLeast(humanLevel, grant.level)" in rotate_fn
        and "level: humanLevel" in rotate_fn
        and 'throw new AgentsError("invalid_key_grant")' in rotate_fn
    )
    m16_no_cascade = (
        '"replaces_key_id"' in keys_table
        and 'onDelete: "set null"' in keys_table
        and "ON DELETE set null" in mig_0021
        and "ON DELETE CASCADE" not in mig_0021
    )
    m16_event = (
        "AgentKeyEventType.enum.agent_key_rotated" in rotate_fn
        and '"agent_key_rotated"' in ag_contract
        and "insert(agentKeyEvents)" in record_fn
        and m11_events_without_secret
    )
    m16_history_surface = (
        "type: row.type" in hist_key_fn
        and "loadKeyEvents(" in hist_ws_fn
        and '"agent_key_rotated"' in ag_contract
    )
    m16_http_problems = (
        "400: problem(" in rotate_route
        and "409: problem(" in rotate_route
        and "201:" in rotate_route
    )
    # M17 (#36): work sessions, claims and five-minute leases. Every guard is read from
    # the service, the fenced projects write, the schema/migration and the adapters, so
    # removing a row lock, the unique index, the lazy expiry or the session gate flips the
    # model to a shortest counterexample naming the exact TS function.
    sess_src = read_text("apps/server/src/features/work-sessions/service.ts")
    sess_rest_src = read_text("apps/server/src/features/work-sessions/rest.ts")
    sess_mcp_src = read_text("apps/server/src/features/work-sessions/mcp.ts")
    sess_index_src = read_text("apps/server/src/features/work-sessions/index.ts")
    mig_0021 = read_text("db/migrations/0022_spooky_barracuda.sql")
    lock_issue_fn = slice_between(sess_src, "async function lockIssue(", "export async function revertIssueToTodo(")
    expire_fn = slice_between(sess_src, "async function expireStale(", "const fiveMinutes")
    claim_fn = slice_between(sess_src, "async claim(actor, input)", "async renew(actor, issueId")
    renew_fn = slice_between(sess_src, "async renew(actor, issueId", "async progress(actor, issueId")
    # #83 made this helper generic so activity appends can return the inserted row while
    # the lease-taking writes still return a WorkSession. Accept either spelling of the
    # declaration as the extraction anchor; the guards below are unchanged.
    live_start = next(
        (
            marker
            for marker in ("const withLiveSession = async <T>(", "const withLiveSession = async (")
            if marker in sess_src
        ),
        "const withLiveSession = async (",
    )
    live_fn = slice_between(sess_src, live_start, "return {")
    # #84 widened readyWork with an optional filter; match the shared prefix so the
    # extraction keeps working for both the old two-argument and the new three-argument form.
    ready_fn = slice_between(sess_src, "async readyWork(actorArg, projectId", "async agentHoldsSession(")
    gate_fn = slice_between(sess_src, "async agentHoldsSession(", "};\n}")
    update_issue_fn = slice_between(proj_src, "async updateIssue(actorArg, issueId, input)", "async listComments(")
    work_sessions_table = slice_between(schema_src, "export const workSessions = pgTable(", "export const workSessionActivities = pgTable(")

    m17_unique_index = (
        "one_active_work_session_per_issue" in mig_0021
        and "one_active_work_session_per_issue" in work_sessions_table
    )
    m17_issue_lock = (
        '.for("update")' in lock_issue_fn
        and "lockIssue(tx" in claim_fn
        and "lockIssue(tx" in live_fn
        and '.for("update")' in update_issue_fn
    )
    m17_lazy_expiry = (
        "lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in expire_fn
        and "status: WorkSessionStatus.enum.expired" in expire_fn
        and "expireStale(tx" in claim_fn
        and "expireStale(tx" in live_fn
    )
    m17_db_time_lease = "statement_timestamp() + interval '5 minutes'" in sess_src
    m17_progress_independent = (
        '"progress"' in work_sessions_table
        and "progress:" not in expire_fn
        and "progressUpdatedAt:" not in expire_fn
    )
    m17_fenced_write = (
        "sessionGate(tx, actor.identity.agentId" in update_issue_fn
        and 'throw new ProjectsError("session_required")' in update_issue_fn
        and "agentHoldsSession:" in sess_index_src
    )
    m17_gate_no_claim = (
        "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in gate_fn
        and "eq(workSessions.status, WorkSessionStatus.enum.active)" in gate_fn
        and ".insert(workSessions)" not in gate_fn
        and "claim(" not in gate_fn
    )
    # The gate runs inside projects' already issue-locked transaction; a second
    # db.transaction there would take another pool connection and can starve/deadlock.
    m17_no_nested_tx = (
        "expireCommitted(" not in gate_fn
        and "db.transaction(" not in gate_fn
    )
    m17_renew_active = (
        "eq(workSessions.status, WorkSessionStatus.enum.active)" in live_fn
        and 'throw new SessionsError("session_required")' in live_fn
    )
    m17_recheck_access = (
        "requireAccess(" in live_fn
        and "projectAccessCeiling" in sess_src
        and '"insufficient_access"' in sess_src
    )
    m17_session_identity = (
        "agentId: identity.agentId" in claim_fn
        and "runId: input.runId" in claim_fn
        and "workspaceId: identity.workspaceId" in claim_fn
        and "keyId" not in claim_fn
    )
    m17_helper_shares = (
        "isSameRun(existing, identity, input.runId)" in claim_fn
        and "return toSession(existing)" in claim_fn
    )
    m17_ready_db_time = (
        "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in ready_fn
        and "eq(issues.needsInput, false)" in ready_fn
        and "isNull(workSessions.id)" in ready_fn
    )
    m17_unfenced = (
        "sessionGate(tx" in update_issue_fn
        and proj_src.count("sessionGate(") == 1
    )
    m17_adapters = (
        "await authenticate(request)" in sess_mcp_src
        and "isAgentError(error)" in sess_rest_src
        and "SessionsError" in sess_rest_src
    )

    # M18 (#40): resume, progress retention, reacquisition and stale-session rejection.
    # Each guard is read from the function that owns the decision, so a deleted guard
    # produces a short counterexample naming the exact operation and TS function.
    sess_contract = read_text("packages/contract/src/sessions.ts")
    resume_fn = slice_between(sess_src, "async resume(actor, input)", "async reacquire(actor, input)")
    reacquire_fn = slice_between(sess_src, "async reacquire(actor, input)", "async getSession(actorArg, issueId)")
    renew_only_fn = slice_between(sess_src, "async renew(", "async progress(")
    progress_only_fn = slice_between(sess_src, "async progress(", "async stop(")
    stop_only_fn = slice_between(sess_src, "async stop(", "async resume(")
    session_columns_fn = slice_between(sess_src, "const sessionColumns =", "const iso =")

    m18_resume_read_only = (
        'accessMode: "read only"' in resume_fn
        and "expireCommitted(" not in resume_fn
        and "expireStale(" not in resume_fn
    )
    sess_state_machine_src = read_text("apps/server/src/features/work-sessions/state-machine.ts")
    m18_resume_db_time = (
        "resumeDispositionFor(effective)" in resume_fn
        and 'if (effective === "expired") return "expired";' in sess_state_machine_src
        and "effectiveStatus" in session_columns_fn
        and "statement_timestamp()" in session_columns_fn
    )
    m18_resume_keeps_progress = "session: toSession(row)" in resume_fn and "progress" in session_columns_fn
    m18_stale_rejected = all(
        "withLiveSession(" in fn
        for fn in (renew_only_fn, progress_only_fn, stop_only_fn)
    ) and 'throw new SessionsError("session_required")' in live_fn
    m18_db_time_liveness = (
        "lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in expire_fn
        and "expireStale(tx" in live_fn
        and "expireCommitted(issueId)" in sess_src
    )
    m18_reacquire_available = (
        "const active = await findActive(tx, issue.id)" in reacquire_fn
        and "fresh?.needsInput" in reacquire_fn
        and 'throw new SessionsError("issue_claimed")' in reacquire_fn
        and 'throw new SessionsError("issue_blocked")' in reacquire_fn
    )
    m18_reacquire_expired_only = (
        "prior.status !== WorkSessionStatus.enum.expired" in reacquire_fn
        and 'throw new SessionsError("session_required")' in reacquire_fn
    )
    m18_reacquire_carries_progress = (
        "progress: prior.progress" in reacquire_fn
        and "progressUpdatedAt: prior.progressUpdatedAt" in reacquire_fn
    )
    m18_reacquire_fresh_session = (
        "id: randomUUID()" in reacquire_fn and "leaseExpiresAt: fiveMinutes" in reacquire_fn
    )
    m18_idempotent = (
        "isSameRun(existing, identity, input.runId)" in claim_fn
        and "isSameRun(active, identity, input.runId)" in reacquire_fn
        and "return toSession(active)" in reacquire_fn
    )
    m18_adapters = (
        "resume_work_session" in sess_mcp_src
        and "reacquire_issue" in sess_mcp_src
        and "resume_work_session" in tools_src
        and "reacquire_issue" in tools_src
        and "ResumeWorkSessionInput" in sess_contract
    )
    m18_http_problems = (
        'path: "/api/issues/{issueId}/work-sessions/resume"' in sess_rest_src
        and 'path: "/api/issues/{issueId}/work-sessions/reacquire"' in sess_rest_src
        and sess_rest_src.count("400: problem(") >= 7
    )
    active_fn = slice_between(sess_src, "async function findActive(", "function requireAccessArgs")
    m18_session_fence = (
        "eq(workSessions.id, sessionId)" in live_fn
        and "sessionId: SessionFence.optional()" in sess_contract
        and "sessionFence(args)" in sess_mcp_src
    )
    m18_closed_refused = 'fresh?.status !== "todo"' in reacquire_fn
    m18_update_db_time = all(
        "liveLease," in fn for fn in (renew_only_fn, progress_only_fn, stop_only_fn)
    )
    m18_find_active_db_time = "liveLease," in active_fn
    m17_tools = all(
        name in tools_src
        for name in (
            "claim_issue",
            "renew_claim",
            "report_progress",
            "stop_session",
            "get_work_session",
            "ready_work",
            "list_work_sessions",
        )
    )
    m17_problems = sess_rest_src.count("400: problem(") >= 5

    # M18 (#37): member removal / voluntary leave versus an in-flight claim renewal.
    # Every decision is read from the live workspaces, work-sessions, agents, projects and
    # REST sources plus the schema/migration, so deleting the release call, the membership
    # recheck, the issue lock order, the last-owner guard or the distinct leave events
    # flips the model to a shortest counterexample naming the exact request.
    ws_rest_src = read_text("apps/server/src/features/workspaces/rest.ts")
    ws_registry_src = read_text("apps/server/src/features/index.ts")
    mig_0023 = read_text("db/migrations/0023_wealthy_silvermane.sql")
    # The cleanup facts are read from the shared tail defined above, and the two call
    # sites are checked separately.
    remove_member_fn = slice_between(ws_src, "async removeMember(", "async leaveWorkspace(")
    leave_fn = slice_between(ws_src, "async leaveWorkspace(", "  };\n}")
    release_fn = slice_between(sess_src, "export async function releaseMemberWorkSessions(", "\n}\n")
    require_access_fn = slice_between(sess_src, "function requireAccessArgs(", "export function createSessionsService(")
    lock_access_fn = slice_between(sess_src, "async function lockAgentWorkspaceAccess(", "export async function releaseMemberWorkSessions(")
    workspace_event_types = slice_between(schema_src, "export const workspaceEventTypes = [", "] as const;")

    m18_release_in_remove = (
        "endMembership(" in remove_member_fn
        and "releaseMemberWorkSessions(tx, workspaceId, humanId)" in end_membership_fn
    )
    m18_release_in_leave = (
        "endMembership(" in leave_fn
        and "releaseMemberWorkSessions(tx, workspaceId, humanId)" in end_membership_fn
    )
    m18_active_only = "eq(workSessions.status, WorkSessionStatus.enum.active)" in release_fn
    m18_release_status_guard = ordered(
        release_fn,
        ".update(workSessions)",
        "eq(workSessions.status, WorkSessionStatus.enum.active)",
    )
    m18_membership_lock = (
        '.for("key share")' in lock_access_fn
        and 'throw new SessionsError("insufficient_access")' in lock_access_fn
        and ordered(claim_fn, "lockAgentWorkspaceAccess(tx, identity)", "lockIssue(tx")
        and ordered(live_fn, "lockAgentWorkspaceAccess(tx, identity)", "lockIssue(tx")
    )
    m18_issue_lock_order = (
        ordered(
            release_fn,
            ".select({ id: workSessions.id, issueId: workSessions.issueId })",
            '.for("update")',
            ".update(workSessions)",
        )
        and ".orderBy(issues.id)" in release_fn
        and "status: WorkSessionStatus.enum.released" in release_fn
    )
    m18_no_nested_tx = "db.transaction(" not in release_fn
    m18_recheck_membership = "humanStillHasWorkspaceAccess(tx, project.workspaceId, humanId)" in require_access_fn
    m18_personal_scope = "workspace.personalOwnerHumanId === humanId" in sess_src
    m18_revoke_keys = (
        "revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
        and "endMembership(" in remove_member_fn
        and "endMembership(" in leave_fn
    )
    m18_revoke_grants = (
        "revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
        and "endMembership(" in remove_member_fn
        and "endMembership(" in leave_fn
    )
    m18_last_owner_leave = 'throw new WorkspacesError("last_owner")' in leave_fn
    m18_personal_not_leavable = "lockWorkspaceForMutation(tx, workspaceId)" in leave_fn
    m18_distinct_events = (
        '"member_left"' in workspace_event_types
        and '"owner_left"' in workspace_event_types
        and '"member_left"' in leave_fn
        and '"owner_left"' in leave_fn
        and "member_left" in mig_0023
        and "owner_left" in mig_0023
    )
    m18_single_tx = "db.transaction(" in remove_member_fn and "db.transaction(" in leave_fn
    m18_attribution_kept = (
        "delete(workspaceMemberships)" in end_membership_fn
        and end_membership_fn.count(".delete(") == 1
    )
    m18_leave_route = (
        'path: "/api/workspaces/{workspaceId}/leave"' in ws_rest_src
        and "leaveKinds" in ws_rest_src
        and "400: problem(" in ws_rest_src
        and "sessions.releaseMemberWorkSessions" in ws_registry_src
    )
    # M20 (#41): the verified three-resolution question lifecycle. Every guard is read from
    # the inbox service, its REST/MCP adapters, the contract/schema/migration and the work
    # session renewal path. Removing a row lock, the DB-time boundary, the pause transition,
    # the needs_input sync or the human-only answer gate flips the model to a shortest trace.
    q_src = read_text("apps/server/src/features/inbox/service.ts")
    q_rest_src = read_text("apps/server/src/features/inbox/rest.ts")
    q_mcp_src = read_text("apps/server/src/features/inbox/mcp.ts")
    q_contract = read_text("packages/contract/src/questions.ts")
    q_migration = read_text("db/migrations/0024_white_rage.sql")
    index_src = read_text("apps/server/src/features/index.ts")
    q_lock_fn = slice_between(q_src, "async function lockIssue(", "async function effectiveFallbackPolicy(")
    q_ask_fn = slice_between(q_src, "async ask(actorArg, input)", "async answer(actorArg")
    q_answer_fn = slice_between(q_src, "async answer(actorArg", "async list(actorArg")
    q_eval_fn = slice_between(q_src, "const evaluateDeadline", "const questionDeadline")
    q_deadline_fn = slice_between(q_src, "const questionDeadline", "export function createInboxService")
    sess_claim_fn = slice_between(sess_src, "async claim(actor, input)", "async renew(actor, issueId")
    sess_renew_fn = slice_between(sess_src, "async renew(actor, issueId", "async progress(actor, issueId")

    m20_statuses = (
        all(s in q_contract for s in ("open", "answered", "paused", "fallback_used"))
        and "'open', 'answered', 'paused', 'fallback_used'" in q_migration
        and "timed_out" not in q_contract
        and "timed_out" not in q_src
    )
    m20_issue_lock = (
        '.for("update")' in q_lock_fn
        and "lockIssue(tx" in q_ask_fn
        and "lockIssue(tx" in q_answer_fn
        and ".for(" in q_answer_fn
    )
    # #123 added optional notify/onActivity seams to evaluateDeadline, so answer() now calls
    # it as evaluateDeadline(tx, issue.id, deps.notifyActivity, deps.onActivity). Match the
    # argument prefix inside answer() itself: the guard still requires the DB-time deadline
    # to be evaluated for this issue on the answer path, not just anywhere in the service.
    m20_answer_evaluates_deadline = bool(
        re.search(r"evaluateDeadline\(tx,\s*issue\.id\s*,", q_answer_fn)
    )
    m20_db_time = (
        "lte(questions.responseDeadlineAt, sql`statement_timestamp()`)" in q_eval_fn
        and m20_answer_evaluates_deadline
        and "statement_timestamp()" in q_answer_fn
        and "interval '1 hour'" in q_ask_fn
    )
    m20_exact_once = (
        "questions.status} in ('open', 'paused')" in q_answer_fn
        and 'throw new InboxError("question_resolved")' in q_answer_fn
    )
    m20_release_pause = (
        'status: "paused"' in q_eval_fn
        and 'status: "released"' in q_eval_fn
        and "needsInput: true" in q_eval_fn
    )
    m20_paused_unblock = (
        "needsInput: false" in q_answer_fn
        and "'open', 'paused'" in q_answer_fn
        and "throw new InboxError(\"question_resolved\")" in q_answer_fn
    )
    m20_needs_sync = (
        "needsInput: true" in q_ask_fn
        and "needsInput: true" in q_eval_fn
        and "needsInput: false" in q_answer_fn
        and "eq(issues.needsInput, false)" in ready_fn
    )
    m20_no_nested = (
        "db.transaction(" not in q_eval_fn
        and "db.transaction(" not in q_deadline_fn
        and "db.transaction(" not in q_lock_fn
    )
    m20_human_only = (
        'throw new InboxError("agents_cannot_answer")' in q_answer_fn
        and "ProjectAccessLevel.enum.contribute" in q_answer_fn
        and "agents_cannot_answer" in q_rest_src
        and "await authenticate(c.req.raw)" in q_rest_src
        and "sessionReader(c)" in q_rest_src
    )
    m20_email_after_commit = (
        "deps.deliver(" in q_ask_fn
        and q_ask_fn.index("deps.deliver(") > q_ask_fn.index("db.transaction(")
    )
    m20_history = all(
        code in q_src
        for code in ("issue_question_asked", "issue_question_answered", "issue_question_paused")
    )
    m20_claim_bounded = (
        "least(" in sess_renew_fn
        and "statement_timestamp()" in sess_renew_fn
        and "needsInput" in sess_claim_fn
        and "questionLeaseDeadline" in index_src
        and "evaluateQuestionDeadline" in index_src
    )
    m20_adapters = (
        "ask_for_input" in tools_src
        and "ask_for_input" in q_mcp_src
        and q_rest_src.count("400: problem(") >= 4
    )
    # The follow-up guards added after review: consistent lock order, non-enumeration,
    # workspace-scoped reads, DB-time effective status, ask scope, the boundary guard and
    # an MCP read tool for the answer.
    sess_deadline_fn = slice_between(sess_src, "const deadlineCommitted", "const expireCommittedForProject =")
    q_columns_fn = slice_between(q_src, "const questionColumns = {", "const iso")
    q_require_fn = slice_between(q_src, "async function requireAccess(", "function requireAgent")
    q_list_fn = slice_between(q_src, "async list(actorArg)", "async issueHistory(actorArg")
    q_history_fn = slice_between(q_src, "async issueHistory(actorArg", "    questionDeadline,")
    m20_lock_order = (
        '.for("update")' in sess_deadline_fn
        and sess_deadline_fn.index('.for("update")') < sess_deadline_fn.index("checkDeadline(tx, issueId)")
    )
    m20_non_enumeration = "if (effective === null) throw new InboxError(missing)" in q_require_fn
    m20_scoped_list = (
        "workspaceMemberships" in q_list_fn
        and "await Promise.all(" not in q_list_fn
        and "inArray(questions.projectId" in q_list_fn
        and ".limit(200)" in q_list_fn
    )
    m20_db_time_reads = (
        "effectiveStatus:" in q_columns_fn
        and "select(questionColumns)" in q_list_fn
        and "select(questionColumns)" in q_history_fn
    )
    m20_ask_scope = (
        "eq(workSessions.runId, input.runId)" in q_ask_fn
        and 'issue.status !== "in_progress"' in q_ask_fn
    )
    m20_boundary_guard = (
        "gt(questions.responseDeadlineAt, sql`statement_timestamp()`)" in q_answer_fn
        # #42 moved the follow-up's isNull guard into storeFollowUp(); the invariant is
        # still that one follow-up is stored, so read it from the whole inbox service.
        and "isNull(questions.followUp)" in q_src
    )
    m20_read_tool = "list_issue_questions" in tools_src and "list_issue_questions" in q_mcp_src
    m20_feature_seams = (
        "inbox.questionDeadline" in index_src
        and "inbox.evaluateDeadline" in index_src
        and "inbox.service." not in index_src
    )


    # M18: personal-to-shared transfer (#39). Every guard below is read from the live
    # transfer service, adapter, contract and generated migration, so deleting a lock,
    # a recheck, a cleanup write or the preview flips the model to its buggy branch.
    tr_src = read_text("apps/server/src/features/transfers/service.ts")
    tr_rest = read_text("apps/server/src/features/transfers/rest.ts")
    tr_contract = read_text("packages/contract/src/transfers.ts")
    mig_0023 = read_text("db/migrations/0025_thick_valeria_richards.sql")
    accept_fn = slice_between(
        tr_src, "async function acceptInTransaction(", "\nexport function createTransfersService"
    )
    preview_impl = tr_src.split("async preview(", 1)[1].split("async authorize(", 1)[0]
    authorize_impl = tr_src.split("async authorize(", 1)[1].split("async receiverPreview(", 1)[0]
    receiver_preview_impl = tr_src.split("async receiverPreview(", 1)[1].split("async accept(", 1)[0]
    accept_impl = tr_src.split("async accept(", 1)[1].split("async complete(", 1)[0]
    complete_impl = tr_src.split("async complete(", 1)[1]

    m21_source_owner = (
        "eq(workspaces.kind, WorkspaceKind.enum.personal)" in tr_src
        and "eq(workspaces.personalOwnerHumanId, humanId)" in tr_src
    )
    # Authorization needs only source ownership: a destination authority is not *required*
    # at authorize time, which is what makes the two-party flow possible. It may be read
    # to decide whether the authorizer is also the receiver, but it must not gate authorize.
    m21_two_party = (
        'throw new TransfersError("destination_authority_required")' not in authorize_impl
    )
    m21_dest_authority = "membership.isOwner || membership.canCreateProjects" in tr_src
    m21_recheck_source = (
        'throw new TransfersError("source_authority_lost")' in accept_fn
        and "source.personalOwnerHumanId !== auth.authorizedByHumanId" in accept_fn
    )
    m21_recheck_authority = (
        "hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId)" in accept_fn
    )
    m21_recheck_workspace = (
        'throw new TransfersError("transfer_stale")' in accept_fn
        and "project.workspaceId !== auth.sourceWorkspaceId" in accept_fn
    )
    m21_active_work = (
        'eq(workSessions.status, "active")' in accept_fn
        and "workSessions.leaseExpiresAt" in accept_fn
    )
    m21_db_time_live = "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in accept_fn
    m21_db_time_expiry = (
        "gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`)" in accept_fn
    )
    m21_single_tx = tr_src.count("db.transaction(") >= 4 and "db.transaction(" not in accept_fn
    m21_lock_first = all(
        ordered(fn, "db.transaction(async (tx) => {", "await lockOwnershipWrites(tx);")
        for fn in (authorize_impl, accept_impl, complete_impl)
    )
    m21_guard_order = "ids.toSorted()" in tr_src and ordered(
        accept_fn,
        "await bumpGuards(tx, [source.id, destination.id]);",
        '.for("update")',
    )
    m21_issue_lock = ordered(
        accept_fn, "from(issues)", '.for("update")', "workSessions.leaseExpiresAt"
    )
    m21_key_cleanup = "tx.delete(agentApiKeyProjects)" in accept_fn
    m21_grant_cleanup = "tx.delete(projectAccessGrants)" in accept_fn
    m21_offer_cleanup = ".delete(workspaceInvitationGrants)" in accept_fn
    m21_grant_rebuild = (
        "tx.insert(projectAccessGrants).values" in accept_fn
        and 'level: "manage"' in accept_fn
        and "async function manageRecipients(" in tr_src
    )
    m21_grant_events = (
        "tx.insert(projectAccessEvents).values" in accept_fn
        and "ProjectAccessEventType.enum.project_access_granted" in accept_fn
    )
    m21_receipt_events = (
        all(
            event_type in tr_src
            for event_type in (
                "project_transfer_authorized",
                "project_transfer_received",
                "project_transferred_out",
            )
        )
        and '"project_transfer_received"' in accept_fn
        and '"project_transferred_out"' in accept_fn
    )
    m21_source_events_scoped = (
        ordered(accept_fn, "workspaceEvent(", "source.id,", '"project_transferred_out"')
        and '"project_transferred_out"' in accept_fn
    )
    m21_preserve_identity = (
        ("set({ workspaceId: destination.id, key: effectiveKey })" in accept_fn or "set({ workspaceId: destination.id })" in accept_fn)
        and ".set({ createdBy" not in accept_fn
        and "createdByHumanId:" not in accept_fn
    )
    m21_preview = (
        "TransferPreview" in tr_contract
        and "activeWork" in tr_contract
        and "accessChanges" in tr_contract
        and "/transfer/preview" in tr_rest
    )
    m21_http_problems = tr_rest.count("400: problem(") >= 4
    m21_human_only = "sessionReader" in tr_rest and "agentAuthenticator" not in tr_rest
    m21_authorization_persisted = (
        'CREATE TABLE "project_transfer_authorizations"' in mig_0023
        and "token_hash" in mig_0023
    )
    # Destination non-enumeration and the receiver's own pre-confirmation view.
    m21_dest_membership_preview = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in preview_impl
    )
    m21_dest_membership_complete = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in complete_impl
    )
    m21_authorize_redaction = (
        "canSeeDestination ? fullPreview : null" in authorize_impl
        and "hasDestinationMembership(" in authorize_impl
    )
    m21_receiver_preview = (
        "/api/transfers/preview" in tr_rest
        and "receiverPreviewTransfer" in tr_rest
        and "async receiverPreview(" in tr_src
    )
    m21_receiver_authority = (
        "hasDestinationMembership(" in receiver_preview_impl
        and "hasCreateProjectsAuthority(" in receiver_preview_impl
        and 'throw new TransfersError("destination_authority_required")' in receiver_preview_impl
    )
    m21_accept_membership = (
        "hasDestinationMembership(tx, auth.destinationWorkspaceId, acceptorHumanId)" in accept_fn
    )
    m21_receiver_recipient = (
        "const receiver = (await hasCreateProjectsAuthority" in preview_impl
        and "const receiver = (await hasCreateProjectsAuthority" in authorize_impl
    )
    # Acceptance cleanup that keeps no stale leases, settled offers or rival tokens.
    m21_expire_lapsed = 'status: "expired"' in accept_fn and "lte(workSessions.leaseExpiresAt" in accept_fn
    m21_pending_offers_only = "eq(workspaceInvitations.status, InvitationStatus.enum.pending)" in accept_fn
    m21_revoke_siblings = (
        'status: "revoked"' in accept_fn and "ne(projectTransferAuthorizations.id, auth.id)" in accept_fn
    )


    # #38: account deactivation/reactivation. The policy lives in one service; the auth
    # refusals live in accounts and agents; the membership predicates and the retained
    # former-owner trigger shape are read from the live sources and migrations.
    deact_src = read_text("apps/server/src/features/deactivation/service.ts")
    deact_rest = read_text("apps/server/src/features/deactivation/rest.ts")
    schema_src = read_text("apps/server/src/db/schema.ts")
    mig_0027 = read_text("db/migrations/0027_account_deactivation_owner_guard.sql")
    deact_fn = slice_between(deact_src, "async deactivate(", "\n    async reactivate(")
    react_fn = slice_between(deact_src, "async reactivate(", "\n  };\n}")
    login_fn = slice_between(acc_src, "    async login(", "    async session(")
    session_fn = slice_between(acc_src, "    async session(", "    async markEmailVerified(")
    resolve_key_fn = slice_between(ag_src, "async function resolveKeyInTransaction(", "export function createAgentsService")

    m22_deactivated_column = "deactivatedAt: timestamp(\"deactivated_at\"" in schema_src
    m22_suspended_column = (
        "suspendedAt: timestamp(\"suspended_at\"" in schema_src
        and "isFormerOwner: boolean(\"is_former_owner\"" in schema_src
    )
    m22_last_admin_guard = 'throw new DeactivationError("last_admin")' in deact_fn
    m22_one_tx = (
        deact_fn.count("db.transaction") == 1
        and react_fn.count("db.transaction") == 1
        and "select lock_workspace_ownership_writes()" in deact_src
    )
    m22_sessions_deleted = "delete(browserSessions)" in deact_fn
    m22_keys_revoked = (
        "revokedAt: sql`statement_timestamp()`" in deact_fn
        and "AgentKeyEventType.enum.agent_key_revoked" in deact_fn
    )
    m22_claims_released = (
        '.for("update")' in deact_fn
        and "WorkSessionStatus.enum.released" in deact_fn
        and "eq(workSessions.status, WorkSessionStatus.enum.active)" in deact_fn
    )
    m22_grants_revoked = (
        "delete(projectAccessGrants)" in deact_fn
        and "ProjectAccessEventType.enum.project_access_revoked" in deact_fn
    )
    m22_membership_suspended = (
        "suspendedAt: sql`statement_timestamp()`" in deact_fn
        and "isFormerOwner: sql`${workspaceMemberships.isOwner}`" in deact_fn
        and "isOwner: false" in deact_fn
    )
    m22_no_restore = (
        ".set({ deactivatedAt: null })" in react_fn
        and "workspaceMemberships" not in react_fn
        and "agentApiKeys" not in react_fn
        and "projectAccessGrants" not in react_fn
        and "deactivatedAt: null" in react_fn
    )
    m22_events = (
        '"account_deactivated"' in deact_fn and '"account_reactivated"' in react_fn
    )
    m22_auth_login = "human.deactivatedAt !== null" in login_fn
    m22_auth_session = "isNull(humans.deactivatedAt)" in session_fn
    m22_auth_key = "row.humanDeactivatedAt !== null" in resolve_key_fn
    m22_membership_checks = (
        "isNull(workspaceMemberships.suspendedAt)" in ws_src
        and "isNull(workspaceMemberships.suspendedAt)" in proj_src
        and "isNull(workspaceMemberships.suspendedAt)" in ag_src
        and "isNull(workspaceMemberships.suspendedAt)" in sess_src
        and "isNull(workspaceMemberships.suspendedAt)" in tr_src
        and "isNull(workspaceMemberships.suspendedAt)" in hist_src
    )
    m22_trigger = (
        "AND suspended_at IS NULL" in mig_0027
        and "suspended_at IS NOT NULL" in mig_0027
        and "is_former_owner" in mig_0027
    )
    m22_http_problems = (
        '400: problem("The account id is invalid")' in deact_rest
        and "401: problem" in deact_rest
        and "403: problem" in deact_rest
        and "404: problem" in deact_rest
        and "409: problem" in deact_rest
    )

    # Follow-up review: uniform lock ordering and active-account guards at every entry point.
    account_by_id_fn = slice_between(deact_src, "async function accountById(", "async function lockOwnershipWrites")
    lock_agent_fn = slice_between(sess_src, "async function lockAgentWorkspaceAccess(", "export async function releaseMemberWorkSessions")
    can_use_fn = slice_between(ag_src, "async function humanCanUseWorkspace(", "async function requireWorkspaceOwner")
    accept_fn_m22 = slice_between(ws_src, "async acceptInvitation(", "async registerThroughInvitation(")
    reset_request_fn = slice_between(rec_src, "async requestReset(email)", "    async confirmReset(token, password)")
    local_recover_fn = slice_between(rec_src, "async localRecover(email, password)", "\n  };\n}")
    reg_install_fn = slice_between(inv_src, "async registerInstallation(input)", "\n  };\n}")
    m22_account_lock = '.for("update")' in account_by_id_fn
    m22_membership_lock = (
        '.for("update")' in deact_fn
        and "workspaceMemberships.id" in deact_fn
    )
    deact_suspend_at = deact_fn.find(".update(workspaceMemberships)")
    deact_revoke_grants_at = deact_fn.find(".delete(projectAccessGrants)")
    deact_release_claims_at = deact_fn.find(".update(workSessions)")
    m22_lock_order = (
        deact_suspend_at >= 0
        and deact_revoke_grants_at >= 0
        and deact_release_claims_at >= 0
        and deact_suspend_at < deact_release_claims_at
        and deact_revoke_grants_at < deact_release_claims_at
    )
    m22_claim_account_lock = (
        ".for(\"key share\")" in lock_agent_fn
        and "humans.deactivatedAt" in lock_agent_fn
    )
    m22_key_issuance_guard = "humanDeactivatedAt !== null" in can_use_fn
    m22_reset_guard = (
        "account.deactivatedAt === null" in reset_request_fn
        and "account.deactivatedAt !== null" in local_recover_fn
    )
    m22_invitation_recheck = (
        "human.deactivatedAt !== null" in accept_fn_m22
        and "isNull(humans.deactivatedAt)" in reg_install_fn
    )
    m22_ownerless_refusal = 'throw new WorkspacesError("ownerless_workspace")' in accept_fn_m22


    # M23 (#42): fallback policy matrix and the 1h branching. Every guard is read from
    # the two policy service methods and their human-only REST routes, the deadline
    # evaluation, the contract/schema/migration and the follow-up path. Flipping any of
    # them makes the bounded model reach a named counterexample.
    pj_rest = read_text("apps/server/src/features/projects/rest.ts")
    pj_contract = read_text("packages/contract/src/projects.ts")
    schema_src = read_text("apps/server/src/db/schema.ts")
    mig_0026 = read_text("db/migrations/0028_fast_puck.sql")
    m23_project_fn = slice_between(
        proj_src, "async setProjectFallbackPolicy(", "async setIssueFallbackPolicyOverride("
    )
    m23_issue_fn = slice_between(
        proj_src,
        "async setIssueFallbackPolicyOverride(",
        "async listProjectAccess(",
    )
    m23_proj_route_fn = slice_between(
        pj_rest, "app.openapi(setProjectFallbackPolicy,", "app.openapi(listProjectAccess,"
    )
    m23_issue_route_fn = slice_between(
        pj_rest, "app.openapi(setIssueFallbackPolicyOverride,", "app.openapi(listComments,"
    )
    m23_eval_fn = slice_between(q_src, "const evaluateDeadline", "const questionDeadline")
    m23_deadline_fn = slice_between(
        q_src, "const questionDeadline", "export function createInboxService"
    )
    m23_policy_fn = slice_between(
        q_src, "async function effectiveFallbackPolicy(", "async function recordActivity("
    )
    m23_fallback_branch = slice_between(
        m23_eval_fn, "if (effectivePolicy === FallbackPolicy.enum.fallback_allowed) {", "const [paused]"
    )
    m23_pause_branch = slice_between(m23_eval_fn, "const [paused]", "\n};")
    m23_follow_fn = slice_between(
        q_src, "async function storeFollowUp(", "function humanIdOf"
    )
    m23_to_question_fn = slice_between(q_src, "function toQuestion", "async function lockIssue(")
    m23_answer_fn = slice_between(q_src, "async answer(actorArg", "async list(actorArg")
    m23_columns_fn = slice_between(q_src, "const questionColumns = {", "const iso")
    m23_sess_renew_fn = slice_between(
        sess_src, "async renew(actor, issueId", "async progress(actor, issueId"
    )
    m23_reacquire_fn = slice_between(sess_src, "async reacquire(actor, input)", "async getSession(")
    m23_tool_names = re.findall(r'name: "([^"]+)"', tools_src)

    m23_contract = (
        '"require_human", "fallback_allowed"' in pj_contract
        and "FallbackPolicyOverride" in pj_contract
        and '"open", "answered", "paused", "fallback_used"' in q_contract
        and "authorizedFallback" in q_contract
    )
    m23_schema = (
        "projects_fallback_policy" in mig_0026
        and "issues_fallback_policy_override" in mig_0026
        and "fallback_policy_override" in schema_src
        and "fallbackPolicy" in schema_src
    )
    m23_project_manage = (
        "ProjectAccessLevel.enum.manage" in m23_project_fn
        and "lockProjectForMutation" in m23_project_fn
        and 'path: "/api/projects/{projectId}/fallback-policy"' in pj_rest
    )
    m23_issue_contribute = (
        "ProjectAccessLevel.enum.contribute" in m23_issue_fn
        and 'path: "/api/issues/{issueId}/fallback-policy"' in pj_rest
        and "recordActivity" in m23_issue_fn
    )
    m23_tighten_only = all(
        marker in m23_issue_fn
        for marker in (
            "override === FallbackPolicy.enum.fallback_allowed",
            "nextEffective === FallbackPolicy.enum.fallback_allowed",
            "currentEffective === FallbackPolicy.enum.require_human",
            "ProjectAccessLevel.enum.manage",
        )
    )
    m23_no_agent = (
        "sessionReader(c)" in m23_proj_route_fn
        and "sessionReader(c)" in m23_issue_route_fn
        and "agentAuthenticator" not in m23_proj_route_fn
        and "agentAuthenticator" not in m23_issue_route_fn
        and not any("policy" in name for name in m23_tool_names)
        and 'throw new InboxError("agents_cannot_answer")' in m23_answer_fn
    )
    m23_effective = (
        "policy?.override ?? policy?.projectPolicy" in m23_policy_fn
        and "effectiveFallbackPolicy(tx, issueId)" in m23_eval_fn
        and "row.fallbackPolicyOverride ?? row.projectFallbackPolicy" in proj_src
        and "coalesce(" in m23_columns_fn
        and "fallbackPolicyOverride" in m23_columns_fn
    )
    # The three edge-case guards added in review: a checking-in worker keeps a full lease
    # under fallback_allowed, reacquisition evaluates a due deadline, and a policy change
    # freezes already-due questions instead of re-projecting their outcome.
    m23_lease_unclipped = (
        "effectiveFallbackPolicy(tx, issueId)" in m23_deadline_fn
        and "FallbackPolicy.enum.require_human" in m23_deadline_fn
    )
    m23_reacquire_deadline = (
        "deadlineCommitted(input.issueId)" in m23_reacquire_fn
        and "checkDeadline(tx, issue.id)" in m23_reacquire_fn
        and "fresh?.needsInput" in m23_reacquire_fn
    )
    m23_freeze = (
        "freezeDueQuestions" in proj_src
        and "lte(questions.responseDeadlineAt, sql`statement_timestamp()`)" in m23_project_fn
        and "evaluateQuestionDeadline?.(tx, issueId)" in m23_issue_fn
        and "evaluateQuestionDeadline: evaluateDeadline" in index_src
    )
    # #1845778 added a lapsed-only cleanup inside the fallback branch: when no live claim
    # exists it expires already-lapsed sessions and reverts the issue to todo. It never
    # releases a checking-in claim, which is what this guard protects. A blanket "no
    # workSessions update" no longer describes the code, so allow session writes only when
    # they are gated by a DB-time live-claim check and every UPDATE is lapsed-lease only.
    fallback_session_updates = m23_fallback_branch.split("update(workSessions")[1:]
    m23_fallback_keeps_live_claim = (
        'status: "released"' not in m23_fallback_branch
        and (
            not fallback_session_updates
            or (
                "const [liveClaim]" in m23_fallback_branch
                and "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in m23_fallback_branch
                and all(
                    "lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in block
                    for block in fallback_session_updates
                )
            )
        )
    )
    m23_branch = (
        'status: "fallback_used"' in m23_fallback_branch
        and "needsInput: false" in m23_fallback_branch
        and m23_fallback_keeps_live_claim
        and 'status: "released"' in m23_pause_branch
        and "needsInput: true" in m23_pause_branch
    )
    m23_db_time = (
        "lte(questions.responseDeadlineAt, sql`statement_timestamp()`)" in m23_eval_fn
        and '.for("update")' in q_lock_fn
    )
    m23_authorized_only = (
        "authorizedFallback: status === QuestionStatus.enum.fallback_used" in m23_to_question_fn
    )
    m23_follow_up = (
        'eq(questions.status, "fallback_used")' in m23_follow_fn
        and "isNull(questions.followUp)" in m23_follow_fn
        and "issue_question_follow_up" in m23_follow_fn
        and "update(issues)" not in m23_follow_fn
        and "await followUp()" in m23_answer_fn
    )
    m23_no_enlarge = (
        "sessionGate(tx" in proj_src
        and "projectAccessCeiling" in sess_src
        and "projectAccessAtLeast" in sess_src
        and "withLiveSession" in m23_sess_renew_fn
    )
    m23_activity = (
        "issue_question_fallback_used" in q_src
        and "issue_question_follow_up" in q_src
        and "project_fallback_policy_changed" in proj_src
        and "issue_fallback_policy_override_changed" in proj_src
    )
    m23_problems = pj_rest.count("400: problem(") >= 6

    # M18: personal-to-shared transfer (#39). Every guard below is read from the live
    # transfer service, adapter, contract and generated migration, so deleting a lock,
    # a recheck, a cleanup write or the preview flips the model to its buggy branch.
    tr_src = read_text("apps/server/src/features/transfers/service.ts")
    tr_rest = read_text("apps/server/src/features/transfers/rest.ts")
    tr_contract = read_text("packages/contract/src/transfers.ts")
    mig_0023 = read_text("db/migrations/0025_thick_valeria_richards.sql")
    accept_fn = slice_between(
        tr_src, "async function acceptInTransaction(", "\nexport function createTransfersService"
    )
    preview_impl = tr_src.split("async preview(", 1)[1].split("async authorize(", 1)[0]
    authorize_impl = tr_src.split("async authorize(", 1)[1].split("async receiverPreview(", 1)[0]
    receiver_preview_impl = tr_src.split("async receiverPreview(", 1)[1].split("async accept(", 1)[0]
    accept_impl = tr_src.split("async accept(", 1)[1].split("async complete(", 1)[0]
    complete_impl = tr_src.split("async complete(", 1)[1]

    m21_source_owner = (
        "eq(workspaces.kind, WorkspaceKind.enum.personal)" in tr_src
        and "eq(workspaces.personalOwnerHumanId, humanId)" in tr_src
    )
    # Authorization needs only source ownership: a destination authority is not *required*
    # at authorize time, which is what makes the two-party flow possible. It may be read
    # to decide whether the authorizer is also the receiver, but it must not gate authorize.
    m21_two_party = (
        'throw new TransfersError("destination_authority_required")' not in authorize_impl
    )
    m21_dest_authority = "membership.isOwner || membership.canCreateProjects" in tr_src
    m21_recheck_source = (
        'throw new TransfersError("source_authority_lost")' in accept_fn
        and "source.personalOwnerHumanId !== auth.authorizedByHumanId" in accept_fn
    )
    m21_recheck_authority = (
        "hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId)" in accept_fn
    )
    m21_recheck_workspace = (
        'throw new TransfersError("transfer_stale")' in accept_fn
        and "project.workspaceId !== auth.sourceWorkspaceId" in accept_fn
    )
    m21_active_work = (
        'eq(workSessions.status, "active")' in accept_fn
        and "workSessions.leaseExpiresAt" in accept_fn
    )
    m21_db_time_live = "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in accept_fn
    m21_db_time_expiry = (
        "gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`)" in accept_fn
    )
    m21_single_tx = tr_src.count("db.transaction(") >= 4 and "db.transaction(" not in accept_fn
    m21_lock_first = all(
        ordered(fn, "db.transaction(async (tx) => {", "await lockOwnershipWrites(tx);")
        for fn in (authorize_impl, accept_impl, complete_impl)
    )
    m21_guard_order = "ids.toSorted()" in tr_src and ordered(
        accept_fn,
        "await bumpGuards(tx, [source.id, destination.id]);",
        '.for("update")',
    )
    m21_issue_lock = ordered(
        accept_fn, "from(issues)", '.for("update")', "workSessions.leaseExpiresAt"
    )
    m21_key_cleanup = "tx.delete(agentApiKeyProjects)" in accept_fn
    m21_grant_cleanup = "tx.delete(projectAccessGrants)" in accept_fn
    m21_offer_cleanup = ".delete(workspaceInvitationGrants)" in accept_fn
    m21_grant_rebuild = (
        "tx.insert(projectAccessGrants).values" in accept_fn
        and 'level: "manage"' in accept_fn
        and "async function manageRecipients(" in tr_src
    )
    m21_grant_events = (
        "tx.insert(projectAccessEvents).values" in accept_fn
        and "ProjectAccessEventType.enum.project_access_granted" in accept_fn
    )
    m21_receipt_events = (
        all(
            event_type in tr_src
            for event_type in (
                "project_transfer_authorized",
                "project_transfer_received",
                "project_transferred_out",
            )
        )
        and '"project_transfer_received"' in accept_fn
        and '"project_transferred_out"' in accept_fn
    )
    m21_source_events_scoped = (
        ordered(accept_fn, "workspaceEvent(", "source.id,", '"project_transferred_out"')
        and '"project_transferred_out"' in accept_fn
    )
    m21_preserve_identity = (
        ("set({ workspaceId: destination.id, key: effectiveKey })" in accept_fn or "set({ workspaceId: destination.id })" in accept_fn)
        and ".set({ createdBy" not in accept_fn
        and "createdByHumanId:" not in accept_fn
    )
    m21_preview = (
        "TransferPreview" in tr_contract
        and "activeWork" in tr_contract
        and "accessChanges" in tr_contract
        and "/transfer/preview" in tr_rest
    )
    m21_http_problems = tr_rest.count("400: problem(") >= 4
    m21_human_only = "sessionReader" in tr_rest and "agentAuthenticator" not in tr_rest
    m21_authorization_persisted = (
        'CREATE TABLE "project_transfer_authorizations"' in mig_0023
        and "token_hash" in mig_0023
    )
    # Destination non-enumeration and the receiver's own pre-confirmation view.
    m21_dest_membership_preview = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in preview_impl
    )
    m21_dest_membership_complete = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in complete_impl
    )
    m21_authorize_redaction = (
        "canSeeDestination ? fullPreview : null" in authorize_impl
        and "hasDestinationMembership(" in authorize_impl
    )
    m21_receiver_preview = (
        "/api/transfers/preview" in tr_rest
        and "receiverPreviewTransfer" in tr_rest
        and "async receiverPreview(" in tr_src
    )
    m21_receiver_authority = (
        "hasDestinationMembership(" in receiver_preview_impl
        and "hasCreateProjectsAuthority(" in receiver_preview_impl
        and 'throw new TransfersError("destination_authority_required")' in receiver_preview_impl
    )
    m21_accept_membership = (
        "hasDestinationMembership(tx, auth.destinationWorkspaceId, acceptorHumanId)" in accept_fn
    )
    m21_receiver_recipient = (
        "const receiver = (await hasCreateProjectsAuthority" in preview_impl
        and "const receiver = (await hasCreateProjectsAuthority" in authorize_impl
    )
    # Acceptance cleanup that keeps no stale leases, settled offers or rival tokens.
    m21_expire_lapsed = 'status: "expired"' in accept_fn and "lte(workSessions.leaseExpiresAt" in accept_fn
    m21_pending_offers_only = "eq(workspaceInvitations.status, InvitationStatus.enum.pending)" in accept_fn
    m21_revoke_siblings = (
        'status: "revoked"' in accept_fn and "ne(projectTransferAuthorizations.id, auth.id)" in accept_fn
    )




    # M24 (#46): shared-to-shared transfer. Reuse the transfer slices above; the new
    # guards come from the shared-source authority path, the acceptance recheck, the
    # workspace-scoped access-event insert/migration and the history filter.
    shared_source_fn = slice_between(
        tr_src, "async function readSharedSourceProject(", "async function readSourceProject("
    )
    source_dispatch_fn = slice_between(
        tr_src, "async function readSourceProject(", "async function readSharedDestination("
    )
    access_events_table = slice_between(
        ag_schema,
        "export const projectAccessEvents = pgTable(",
        "export const agents = pgTable(",
    )
    mig_0026 = read_text("db/migrations/0029_numerous_clint_barton.sql")
    m24_shared_source = (
        "eq(workspaceMemberships.isOwner, true)" in shared_source_fn
        and 'throw new TransfersError("project_not_found")' in shared_source_fn
        and "readSharedSourceProject(tx, projectId, humanId)" in source_dispatch_fn
    )
    m24_recheck_shared_owner = (
        "source.kind === WorkspaceKind.enum.shared" in accept_fn
        and "eq(workspaceMemberships.isOwner, true)" in accept_fn
        and 'throw new TransfersError("source_authority_lost")' in accept_fn
    )
    m24_same_workspace = (
        "function rejectSameWorkspace(" in tr_src
        and 'throw new TransfersError("same_workspace")' in tr_src
        and tr_src.count("rejectSameWorkspace(") >= 4
    )
    m24_visibility = (
        '"shared_to_shared"' in tr_src
        and 'z.enum(["personal_to_shared", "shared_to_shared"])' in tr_contract
    )
    m24_access_event_scope = (
        'workspaceId: text("workspace_id")' in access_events_table
        and "SET NOT NULL" in mig_0026
        and "FROM \"projects\" p" in mig_0026
    )
    m24_grant_event_workspace = "workspaceId: destination.id" in accept_fn
    m24_history_filter = (
        "eq(projectAccessEvents.workspaceId, workspaceId)" in hist_src
        and "loadProjectAccessEvents(" in hist_src
    )
    m24_history_project_filter = (
        "loadProjectAccessEvents(tx" in hist_proj_fn and "project.workspaceId" in hist_proj_fn
    )
    m24_key_cleanup = "tx.delete(agentApiKeyProjects)" in accept_fn
    m24_grant_cleanup = "tx.delete(projectAccessGrants)" in accept_fn
    m24_offer_cleanup = ".delete(workspaceInvitationGrants)" in accept_fn
    m24_pending_offers_only = "eq(workspaceInvitations.status, InvitationStatus.enum.pending)" in accept_fn
    m24_revoke_siblings = "ne(projectTransferAuthorizations.id, auth.id)" in accept_fn
    m24_grant_rebuild = (
        "tx.insert(projectAccessGrants).values" in accept_fn and 'level: "manage"' in accept_fn
    )
    m24_grant_events = (
        "tx.insert(projectAccessEvents).values" in accept_fn
        and "ProjectAccessEventType.enum.project_access_granted" in accept_fn
    )
    m24_receipt_events = (
        '"project_transferred_out"' in accept_fn and '"project_transfer_received"' in accept_fn
    )
    m24_two_party = 'throw new TransfersError("destination_authority_required")' not in authorize_impl
    m24_authorize_redaction = "canSeeDestination ? fullPreview : null" in authorize_impl
    m24_receiver_preview = (
        "async receiverPreview(" in tr_src and "/api/transfers/preview" in tr_rest
    )
    m24_receiver_authority = (
        "hasDestinationMembership(" in receiver_preview_impl
        and "hasCreateProjectsAuthority(" in receiver_preview_impl
    )
    m24_dest_membership_preview = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in preview_impl
    )
    m24_dest_membership_complete = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in complete_impl
    )
    m24_accept_membership = (
        "hasDestinationMembership(tx, auth.destinationWorkspaceId, acceptorHumanId)" in accept_fn
    )
    m24_dest_authority = "hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId)" in accept_fn
    m24_recheck_workspace = "project.workspaceId !== auth.sourceWorkspaceId" in accept_fn
    m24_active_work = (
        'eq(workSessions.status, "active")' in accept_fn and "workSessions.leaseExpiresAt" in accept_fn
    )
    m24_db_time_live = "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in accept_fn
    m24_db_time_expiry = (
        "gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`)" in accept_fn
    )
    m24_single_tx = tr_src.count("db.transaction(") >= 4 and "db.transaction(" not in accept_fn
    m24_lock_first = all(
        ordered(fn, "db.transaction(async (tx) => {", "await lockOwnershipWrites(tx);")
        for fn in (authorize_impl, accept_impl, complete_impl)
    )
    m24_guard_order = "ids.toSorted()" in tr_src and ordered(
        accept_fn, "await bumpGuards(tx, [source.id, destination.id]);", '.for("update")'
    )
    m24_issue_lock = ordered(
        accept_fn, "from(issues)", '.for("update")', "workSessions.leaseExpiresAt"
    )
    m24_preserve_identity = (
        ("set({ workspaceId: destination.id, key: effectiveKey })" in accept_fn or "set({ workspaceId: destination.id })" in accept_fn) and ".set({ createdBy" not in accept_fn
    )
    m24_expire_lapsed = 'status: "expired"' in accept_fn and "lte(workSessions.leaseExpiresAt" in accept_fn
    m24_http_problems = tr_rest.count("400: problem(") >= 4
    m24_human_only = "sessionReader" in tr_rest and "agentAuthenticator" not in tr_rest

    # --- M26 (#82): Human stop requests on active work sessions ---
    ws_sess_src = read_text("apps/server/src/features/work-sessions/service.ts")
    proj_src = read_text("apps/server/src/features/projects/service.ts")
    sessions_contract_src = read_text("packages/contract/src/sessions.ts")
    stop_access_fn = slice_between(
        ws_sess_src, "async function requireHumanStopAccess(", "async function requireActivityReadAccess("
    )
    request_stop_fn = slice_between(ws_sess_src, "async requestStop(", "async activeSessions(")
    m26_human_only = (
        'throw new SessionsError("human_sign_in_required")' in request_stop_fn
        and 'throw new SessionsError("agents_cannot_request_stop")' in request_stop_fn
    )
    m26_lock_order = ordered(
        stop_access_fn,
        "isNull(humans.deactivatedAt)",
        '.for("key share")',
        "isNull(workspaceMemberships.suspendedAt)",
        "lockIssue(tx, issueId)",
    )
    m26_non_enum = (
        'if (caller === undefined) throw new SessionsError("issue_not_found")' in stop_access_fn
        and 'if (membership === undefined) throw new SessionsError("issue_not_found")' in stop_access_fn
    )
    m26_idempotent = "if (session.stopRequestedAt !== null) return { session: toSession(session) }" in request_stop_fn
    m26_db_time_write = (
        ".update(workSessions)" in request_stop_fn
        and "liveLease" in request_stop_fn.split(".update(workSessions)", 1)[1]
    )
    m26_activity_atomic = (
        "ProjectActivityType.enum.issue_stop_requested" in request_stop_fn
        and request_stop_fn.count("db.transaction(") == 1
    )
    m26_schema_check = "work_sessions_stop_request" in schema_src

    # --- M27 (#86): Acyclic issue dependencies & ready-work exclusion ---
    add_dep_fn = slice_between(proj_src, "async addBlockedBy(", "async removeBlockedBy(")
    ready_work_fn = slice_between(ws_sess_src, "async readyWork(", "async agentHoldsSession(")
    m27_no_self_link = (
        'if (issueId === blockedByIssueId) throw new ProjectsError("self_dependency")' in add_dep_fn
        and "issue_dependencies_no_self_link" in schema_src
    )
    m27_same_project = (
        'throw new ProjectsError("cross_project_dependency")' in add_dep_fn
        and "blocker.projectId !== current.projectId" in add_dep_fn
    )
    m27_project_lock = (
        ".from(projects)" in add_dep_fn
        and '.for("update")' in add_dep_fn.split(".from(projects)", 1)[1]
    )
    # Global lock order (shared with transfers M21/M24): projects FOR UPDATE must not come
    # after an issues FOR UPDATE lock in the same transaction, or concurrent transfer + addBlockedBy can AB-BA deadlock.
    m27_lock_order = (
        ".from(projects)" in add_dep_fn
        and (
            ".from(issues)" not in add_dep_fn
            or add_dep_fn.index(".from(projects)") < add_dep_fn.index(".from(issues)")
        )
    )
    m27_cycle_bfs = (
        'throw new ProjectsError("dependency_cycle")' in add_dep_fn
        and "visited" in add_dep_fn
    )
    m27_idempotent = "if (existing !== undefined) return toIssueDependency(existing)" in add_dep_fn
    m27_ready_excludes = (
        "notExists(" in ready_work_fn
        and "issueDependencies" in ready_work_fn
        and (
            'notInArray(blockerIssue.status, ["done", "cancelled"])' in ready_work_fn
            or "notInArray(blockerIssue.status, TERMINAL_ISSUE_STATUSES)" in ready_work_fn
        )
    )

    # --- M28 (#83): Ephemeral session activities & deactivation-safe reads ---
    act_read_fn = slice_between(
        ws_sess_src, "async function requireActivityReadAccess(", "export function createSessionsService("
    )
    log_act_fn = slice_between(ws_sess_src, "async logActivity(", "async requestStop(")
    list_act_fn = slice_between(ws_sess_src, "async listActivities(", "async readyWork(")
    m28_live_gate = "withLiveSession(actor, input.issueId, input.sessionId," in log_act_fn
    m28_no_lease_mutation = (
        ".insert(workSessionActivities)" in log_act_fn
        and ".update(workSessions)" not in log_act_fn
        and "issueComments" not in log_act_fn
    )
    m28_read_deactivation = (
        "isNull(humans.deactivatedAt)" in act_read_fn
        and 'if (caller === undefined) throw new SessionsError("issue_not_found")' in act_read_fn
    )
    m28_read_non_enum = (
        'throw new SessionsError("insufficient_access")' not in act_read_fn
        and 'accessMode: "read only"' in list_act_fn
    )
    m28_detail_bound = "64_000" in sessions_contract_src and "JSON.stringify" in sessions_contract_src
    m28_schema_check = "work_session_activities_kind" in schema_src

    # --- M29 (#84): board assignment and the strict claim policy ---
    validate_assignee_fn = slice_between(
        proj_src, "async function validateAssignee(", "async function requireKnowledge("
    )
    mig_0033 = read_text("db/migrations/0031_next_masked_marvel.sql")
    m29_db_check = (
        "issues_assignee_pair" in schema_src
        and "issues_assignee_type" in schema_src
        and "issues_assignee_pair" in mig_0033
        and "issues_assignee_type" in mig_0033
    )
    m29_assignee_validation = (
        "assignee_not_found" in proj_src
        and 'throw new ProjectsError("assignee_not_found")' in validate_assignee_fn
        and "isNull(humans.deactivatedAt)" in validate_assignee_fn
        and "isNull(workspaceMemberships.suspendedAt)" in validate_assignee_fn
        and "agentApiKeys" in validate_assignee_fn
    )
    # The assignee locks precede the caller's issue lock (M22), and the account lock
    # precedes the membership lock, inside validateAssignee itself.
    m29_lock_order = (
        ordered(
            validate_assignee_fn,
            ".from(humans)",
            '.for("key share")',
            ".from(workspaceMemberships)",
            '.for("key share")',
        )
        and update_issue_fn.find("validateAssignee(") < update_issue_fn.find('.for("update")')
    )
    m29_strict_claim = (
        "assertClaimAssignee(issue.assigneeType, issue.assigneeId, identity.agentId)" in claim_fn
        and "assertClaimAssignee(issue.assigneeType, issue.assigneeId, identity.agentId)"
        in reacquire_fn
        and 'throw new SessionsError("issue_assigned_to_human")' in sess_src
        and 'throw new SessionsError("issue_assigned_to_other_agent")' in sess_src
        and "issue_assigned_to_human: 409" in sess_rest_src
        and "issue_assigned_to_other_agent: 409" in sess_rest_src
    )
    m29_ready_filter = (
        'filter === "unassigned"' in ready_fn
        and 'filter === "assignedToMe"' in ready_fn
        and "assigneeFilter" in ready_fn
        and "assignedToActor" in ready_fn
        and "ReadyWorkFilter" in sessions_contract_src
        and 'c.req.valid("query").filter' in sess_rest_src
        and "ReadyWorkFilter.parse" in sess_mcp_src
    )
    m29_contract_surface = (
        "assignee: IssueAssignee" in pj_contract
        and "assignee: Assignee.nullable().optional()" in pj_contract
        and "needsInput: z.boolean()" in pj_contract
        and "assignee_type" in schema_src
    )
    # The access precheck and assignee validation are separate committed transactions;
    # the issue-locked transaction must recheck the workspace before writing the pair.
    m29_workspace_recheck = (
        "current.workspaceId !== target.workspaceId" in update_issue_fn
        and 'throw new ProjectsError("issue_not_found")' in update_issue_fn
    )

    # --- M30 (#94): Six-state issue workflow & session-driven transitions ---
    m30_six_states = (
        '"backlog"' in pj_contract
        and '"todo"' in pj_contract
        and '"in_progress"' in pj_contract
        and '"review"' in pj_contract
        and '"done"' in pj_contract
        and '"cancelled"' in pj_contract
        and "issues_closed_at_matches_status" in schema_src
    )
    m30_claim_to_in_progress = (
        'status: "in_progress"' in claim_fn
        and 'status: "in_progress"' in reacquire_fn
        and 'fresh?.status !== "todo"' in claim_fn
        and '"issue_blocked"' in sess_rest_src
    )
    m30_revert_on_end = (
        "if (expired.length > 0) await revertIssueToTodo(tx, issueId)" in expire_fn
        and "await revertIssueToTodo(tx, issue.id)" in stop_only_fn
        and "await expireCommittedForProject(projectId)" in ready_work_fn
        and 'eq(issues.status, "todo")' in ready_work_fn
    )
    m30_pause_and_lapsed_answer_revert = (
        '.set({ status: "todo", updatedAt: sql`statement_timestamp()` })' in q_eval_fn
        and '.set({ status: "todo", updatedAt: sql`statement_timestamp()` })' in q_answer_fn
    )
    m30_completion_outcomes = (
        "ProjectActivityType.enum.issue_review_handoff" in stop_only_fn
        and "ProjectActivityType.enum.issue_closed" in stop_only_fn
    )

    # M25 (#43): ownership recovery. Every guard comes from the new feature's one service,
    # its human-only REST routes, the minimal directory contract, both event writes, the
    # history filter, and the migration that permits the retained former-owner shape.
    own_src = read_text("apps/server/src/features/ownership/service.ts")
    own_rest = read_text("apps/server/src/features/ownership/rest.ts")
    own_contract = read_text("packages/contract/src/ownership.ts")
    recover_fn = slice_between(own_src, "async recoverOwnership(", "\n  };\n}")
    directory_fn = slice_between(own_src, "async directory(", "async recoverOwnership(")
    admin_fn = slice_between(own_src, "async function requireActiveAdministrator(", "async function lockOwnershipWrites")
    notify_fn = slice_between(own_src, "async function notifyMembers(", "export function createOwnershipService")
    directory_schema = slice_between(own_contract, "export const InstallationWorkspace = z", "export type InstallationWorkspace =")
    hist_account_fn = slice_between(hist_src, "async function loadAccountStatusEvents(", "export interface HistoryDeps")
    mig_0030 = read_text("db/migrations/0030_neat_tusk.sql")

    m25_one_tx = recover_fn.count("db.transaction(") == 1 and "await notifyMembers(db, deliver, log, {" in recover_fn
    m25_lock_first = ordered(recover_fn, "db.transaction(async (tx) => {", "await lockOwnershipWrites(tx);")
    m25_admin_recheck = (
        "await requireActiveAdministrator(tx, actor.humanId)" in recover_fn
        and "await requireActiveAdministrator(tx, actor.humanId)" in directory_fn
        and "eq(humans.isSystemAdministrator, true)" in admin_fn
        and "isNull(humans.deactivatedAt)" in admin_fn
    )
    m25_shared_only = (
        "workspace.kind !== WorkspaceKind.enum.shared" in recover_fn
        and 'throw new OwnershipError("workspace_not_found")' in recover_fn
    )
    m25_guard_bump = ordered(recover_fn, "await bumpGuard(tx, workspaceId)", "self_recovery_forbidden")
    m25_self_guard = (
        "targetHumanId === actor.humanId" in recover_fn
        and 'throw new OwnershipError("self_recovery_forbidden")' in recover_fn
    )
    m25_active_owner_guard = (
        'throw new OwnershipError("workspace_has_active_owner")' in recover_fn
        and "eq(workspaceMemberships.isOwner, true)" in recover_fn
        and "isNull(workspaceMemberships.suspendedAt)" in recover_fn
        and "(owners?.count ?? 0) >= 1" in recover_fn
    )
    m25_target_active_guard = (
        "target.deactivatedAt !== null" in recover_fn
        and 'throw new OwnershipError("target_deactivated")' in recover_fn
    )
    m25_membership_guard = (
        "membership.suspendedAt === null" in recover_fn
        and "membership.isFormerOwner" in recover_fn
        and 'throw new OwnershipError("member_not_found")' in recover_fn
        and 'throw new OwnershipError("recipient_ineligible")' in recover_fn
    )
    m25_promote = (
        "set({ isOwner: true, suspendedAt: null, isFormerOwner: false })" in recover_fn
        and "insert(workspaceMemberships)" not in recover_fn
    )
    m25_events = (
        recover_fn.count('type: "workspace_ownership_recovered"') >= 2
        and "insert(workspaceEvents)" in recover_fn
        and "insert(accountRecoveryEvents)" in recover_fn
        and "'workspace_ownership_recovered'" in mig_0030
    )
    m25_history = (
        '"workspace_ownership_recovered"' in hist_account_fn
        and "eq(workspaceEvents.workspaceId, workspaceId)" in hist_src
    )
    m25_directory_scope = (
        "projects" not in directory_fn
        and "issues" not in directory_fn
        and "knowledge" not in directory_fn
        and "project" not in directory_schema
        and "eq(workspaces.kind, WorkspaceKind.enum.shared)" in directory_fn
    )
    m25_human_only = "sessionReader" in own_rest and "agentAuthenticator" not in own_rest
    m25_http_problems = all(f"{code}: problem(" in own_rest for code in (400, 401, 403, 404, 409))
    m25_notify_after_commit = (
        ordered(
            recover_fn,
            "const { workspaceName, ...result } = await db.transaction",
            "await notifyMembers(db, deliver, log, {",
        )
        and "await deliver({ to, subject, text })" in notify_fn
    )
    m25_no_admin_grant = (
        "insert(projectAccessGrants)" not in recover_fn
        and "insert(projectAccessGrants)" not in notify_fn
        and "insert(workspaceMemberships)" not in recover_fn
    )
    m25_no_key_revival = "agentApiKeys" not in recover_fn and "agentApiKeys" not in notify_fn

    # M31 (#97): project-scoped labels and one-level subtask invariants.
    mig_0038 = read_text("db/migrations/0038_subtask_and_label_invariants.sql")
    validate_parent_fn = slice_between(proj_src, "async function validateParent(", "async function validateAssignee(")
    attach_label_fn = slice_between(proj_src, "async attachLabel(actorArg, issueId, labelId)", "async detachLabel(")
    m31_no_self_parent = (
        "issueId === parentIssueId" in validate_parent_fn
        and "issues_no_self_parent" in schema_src
        and "NEW.parent_issue_id = NEW.id" in mig_0038
    )
    m31_same_project_parent = (
        "parent.projectId !== projectId" in validate_parent_fn
        and "parent_project <> NEW.project_id" in mig_0038
        and "NEW.project_id <> OLD.project_id" in mig_0038
    )
    m31_depth_one = (
        "parent.parentIssueId !== null" in validate_parent_fn
        and "eq(issues.parentIssueId, issueId)" in validate_parent_fn
        and "parent_parent IS NOT NULL" in mig_0038
        and "EXISTS (SELECT 1 FROM issues WHERE parent_issue_id = NEW.id)" in mig_0038
    )
    m31_trigger_lock_order = (
        "IF NEW.id < NEW.parent_issue_id THEN" in mig_0038
        and "FOR UPDATE;" in mig_0038
    )
    m31_label_same_project = (
        "label.projectId !== issue.projectId" in attach_label_fn
        and "issue_labels_same_project" in mig_0038
        and "issue_project IS DISTINCT FROM label_project" in mig_0038
    )
    m31_label_schema_guards = (
        "one_label_name_per_project" in schema_src
        and "lower(${t.name})" in schema_src
        and "project_labels_color" in schema_src
    )

    # M32 (#98): human-only soft-delete Trash, Project manager restore, and 30-day scrub.
    mig_0039 = read_text("db/migrations/0039_cooing_alex_wilder.sql")
    delete_issue_fn = slice_between(proj_src, "async deleteIssue(actorArg, issueId)", "async restoreIssue(")
    restore_issue_fn = slice_between(proj_src, "async restoreIssue(actorArg, issueId)", "async listTrash(")
    list_trash_fn = slice_between(proj_src, "async listTrash(actorArg, projectId)", "async purgeExpiredTrash(")
    purge_trash_fn = slice_between(proj_src, "async purgeExpiredTrash()", "async createIssue(")
    m32_human_only_delete = (
        'actor.kind !== "human"' in delete_issue_fn
        and "agents_cannot_delete_issues" in delete_issue_fn
        and 'actor.kind !== "human"' in restore_issue_fn
        and 'actor.kind !== "human"' in list_trash_fn
    )
    m32_active_session_guard = (
        '.for("update")' in delete_issue_fn
        and "issueSessionGate(tx, issueId)" in delete_issue_fn
        and "issue_active_session_exists" in delete_issue_fn
    )
    m32_manage_restore_db_window = (
        "ProjectAccessLevel.enum.manage" in restore_issue_fn
        and '.for("update")' in restore_issue_fn
        and "current.purgedAt !== null || expired !== undefined" in restore_issue_fn
        and "issue_purged" in restore_issue_fn
        and "THIRTY_DAYS_AGO" in restore_issue_fn
    )
    m32_scrub_preserves_tombstone = (
        "delete(issueComments)" in purge_trash_fn
        and "delete(issueLinks)" in purge_trash_fn
        and "delete(issueLabels)" in purge_trash_fn
        and "delete(issueDependencies)" in purge_trash_fn
        and 'title: "[deleted]"' in purge_trash_fn
        and 'body: ""' in purge_trash_fn
        and "purgedAt: sql`statement_timestamp()`" in purge_trash_fn
        and "delete(issues)" not in purge_trash_fn
    )
    m32_schema_and_read_exclusion = (
        "issues_deleted_pair" in schema_src
        and "issues_purged_requires_deleted" in schema_src
        and "issues_deleted_pair" in mig_0039
        and "issues_purged_requires_deleted" in mig_0039
        and "isNull(issues.deletedAt)" in ready_fn
    )

    # M33 (#99): cross-workspace My work access boundaries.
    my_work_src = read_text("apps/server/src/features/my-work/service.ts")
    my_work_rest = read_text("apps/server/src/features/my-work/rest.ts")
    m33_human_session_only = (
        "sessionReader(c)" in my_work_rest
        and "agentAuthenticator" not in my_work_rest
        and 'throw new MyWorkError("not_signed_in")' in my_work_src
    )
    m33_deactivated_refused = (
        "human.deactivatedAt !== null" in my_work_src
        and 'throw new MyWorkError("human_deactivated")' in my_work_src
    )
    m33_live_membership_and_ceiling = (
        "isNull(workspaceMemberships.suspendedAt)" in my_work_src
        and "projectAccessCeiling(" in my_work_src
        and "ProjectAccessLevel.enum.read" in my_work_src
        and "ProjectAccessLevel.enum.contribute" in my_work_src
    )
    m33_assigned_and_session_filters = (
        "isNull(issues.deletedAt)" in my_work_src
        and "notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES])" in my_work_src
        and "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in my_work_src
    )
    m33_questions_db_time_contribute = (
        "inArray(questions.projectId, actionable)" in my_work_src
        and "effectiveQuestionStatus" in my_work_src
        and "statement_timestamp()" in my_work_src
    )

    # M34 (#123): proactive expiry sweeper, issue_session_expired, and in-app notifications.
    mig_0042 = read_text("db/migrations/0042_nosy_marauders.sql")
    notif_src = read_text("apps/server/src/features/notifications/service.ts")
    notif_rest = read_text("apps/server/src/features/notifications/rest.ts")
    notif_table = slice_between(
        schema_src,
        "export const notifications = pgTable(",
        "export const webhooks = pgTable(",
    )
    notif_readable_fn = slice_between(notif_src, "const readableAccess =", "export function createNotificationsService")
    notif_create_fn = slice_between(notif_src, "const createForActivity: NotifyActivity =", "const notificationColumns =")
    notif_list_fn = slice_between(notif_src, "async list(actor, input = {})", "async markRead(")
    notif_mark_read_fn = slice_between(notif_src, "async markRead(actor, notificationId)", "async markAllRead(")
    notif_mark_all_fn = slice_between(notif_src, "async markAllRead(actor)", "async prune(")
    notif_prune_fn = slice_between(notif_src, "async prune()", "\n  };\n}")
    sess_sweep_fn = slice_between(sess_src, "async sweep()", "async agentHoldsSession(")
    q_due_ids_fn = slice_between(q_src, "async findDueQuestionIssueIds()", "\n  };\n}")
    sweep_check_at = sess_sweep_fn.find("await checkDeadline(tx, issueId)")
    sweep_expire_at = sess_sweep_fn.find("await expireStale(tx, issueId")
    m34_auth_boundary = (
        "await authenticate(c.req.raw)" in notif_rest
        and "isAgentError(error)" in notif_rest
        and "authorization" not in notif_rest
        and 'actor.kind === "agent"' in notif_src
        and 'throw new NotificationsError("agents_cannot_use_notifications")' in notif_src
        and 'throw new NotificationsError("not_signed_in")' in notif_src
    )
    m34_per_issue_sweep_order = (
        "QuestionStatus.enum.open" in q_due_ids_fn
        and ".from(questions)" not in sess_src
        and "for (const issueId of issueIds)" in sess_sweep_fn
        and "await db.transaction(async (tx) =>" in sess_sweep_fn
        and sweep_check_at >= 0
        and sweep_expire_at >= 0
        and sweep_check_at < sweep_expire_at
        and "if (sweeping) return;" in sess_index_src
    )
    m34_atomic_idempotent_schema = (
        "one_notification_per_human_and_activity" in notif_table
        and "one_notification_per_human_and_activity" in mig_0042
        and "notifications_human_unread" in mig_0042
        and "workspace_id" not in notif_table
        and ".onConflictDoNothing()" in notif_create_fn
        and "issue_session_expired" in mig_0042
    )
    m34_live_access_non_enum = (
        "${workspaces.id} = ${projects.workspaceId}" in notif_readable_fn
        and "${workspaceMemberships.suspendedAt} is null" in notif_readable_fn
        and all(
            "callerIsActive(tx, humanId)" in fn
            and "readableAccess(humanId)" in fn
            and "isNull(issues.deletedAt)" in fn
            for fn in (notif_list_fn, notif_mark_read_fn, notif_mark_all_fn)
        )
    )
    m34_lossless_cursor_and_prune = (
        "YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"" in notif_src
        and "decodeCursor(" in notif_list_fn
        and 'throw new NotificationsError("invalid_cursor")' in notif_src
        and "interval '90 days'" in notif_prune_fn
        and "interval '180 days'" in notif_prune_fn
    )

    # M35 (#124): workspace-scoped outgoing webhooks, transactional outbox, SSRF DNS pinning & circuit breaker.
    mig_0043 = read_text("db/migrations/0043_round_demogoblin.sql")
    wh_src = read_text("apps/server/src/features/webhooks/service.ts")
    wh_rest = read_text("apps/server/src/features/webhooks/rest.ts")
    wh_index = read_text("apps/server/src/features/webhooks/index.ts")
    wh_contract = read_text("packages/contract/src/webhooks.ts")
    wh_tables = slice_between(schema_src, "export const webhooks = pgTable(", None)
    wh_require_owner = slice_between(wh_src, "async function requireOwner(", "export function createWebhooksService(")
    wh_enqueue = slice_between(wh_src, "const enqueueForActivity: EnqueueWebhookActivity =", "const attempt =")
    wh_attempt = slice_between(wh_src, "const attempt =", "const finalize =")
    wh_finalize = slice_between(wh_src, "const finalize =", "return {")
    wh_create = slice_between(wh_src, "async create(actor, workspaceId, input)", "async update(")
    wh_update = slice_between(wh_src, "async update(actor, workspaceId, webhookId, input)", "async rotateSecret(")
    wh_rotate = slice_between(wh_src, "async rotateSecret(actor, workspaceId, webhookId)", "async remove(")
    wh_drain = slice_between(wh_src, "async drain()", "async prune(")
    wh_prune = slice_between(wh_src, "async prune()", "\n  };\n}")
    wh_http = slice_between(wh_src, "async function performHttpDelivery(", "async function runWithConcurrency<T>(")
    tr_accept = slice_between(tr_src, "async function acceptInTransaction(", "export function createTransfersService(")
    ws_expire = slice_between(sess_src, "async function expireStale(", "const fiveMinutes =")
    ws_create_svc = slice_between(sess_src, "export function createSessionsService(", "const expireCommitted =")
    rotate_assert_at = wh_rotate.find("assertWebhookInWorkspace(tx, workspaceId, webhookId)")
    rotate_key_at = wh_rotate.find("encryptionKey === undefined")
    expire_revert_at = ws_expire.find("revertIssueToTodo(tx, issueId)")
    expire_on_act_at = ws_expire.find("await onActivity(tx, activityId)")

    m35_owner_rbac_and_cap = (
        "await authenticate(c.req.raw)" in wh_rest
        and "isAgentError(error)" in wh_rest
        and 'throw new WebhooksError("agents_cannot_manage_webhooks")' in wh_require_owner
        and 'throw new WebhooksError("not_workspace_member")' in wh_require_owner
        and 'throw new WebhooksError("not_workspace_owner")' in wh_require_owner
        and '.for("update")' in wh_require_owner
        and "requireOwner(tx, actor, workspaceId, true)" in wh_create
        and 'throw new WebhooksError("webhook_limit_reached")' in wh_create
        and 'throw new WebhooksError("invalid_webhook_scope")' in wh_create
    )
    m35_explicit_scope_and_transfer_non_widening = (
        "all_projects" in wh_tables
        and "all_events" in wh_tables
        and "all_projects" in mig_0043
        and "webhook_projects" in mig_0043
        and "eq(webhooks.allProjects, true)" in wh_enqueue
        and "exists(" in wh_enqueue
        and "eq(webhooks.allEvents, true)" in wh_enqueue
        and ".delete(webhookProjects)" in tr_accept
        and "allProjects" not in tr_accept
    )
    m35_secret_encryption_and_signing = (
        "whsec_" in wh_create
        and "encryptSecret(encryptionKey, signingSecret)" in wh_create
        and "encryptSecret(encryptionKey, signingSecret)" in wh_rotate
        and rotate_assert_at >= 0
        and rotate_key_at > rotate_assert_at
        and "decryptSecret(encryptionKey, hook.secretEncrypted)" in wh_attempt
        and '"webhook_secret_unreadable"' in wh_attempt
        and 'createHmac("sha256", secret)' in wh_http
        and '"x-orrery-signature-256"' in wh_http
        and 'parsed.username === ""' in wh_contract
        and 'parsed.password === ""' in wh_contract
    )
    m35_ssrf_dns_pinned = (
        'url.protocol !== "https:"' in wh_attempt
        and "isBlockedAddress(" in wh_src
        and "parseIpv6SegmentList(" in wh_src
        and "embeddedIpv4Blocked(" in wh_src
        and "if (options.all)" in wh_http
        and "agent: false" in wh_http
        and 'response.on("close"' in wh_http
        and 'response.on("error"' in wh_http
        and "MAX_RESPONSE_BYTES" in wh_http
    )
    m35_atomic_outbox_and_single_enqueue = (
        "webhook_deliveries_webhook_activity" in wh_tables
        and "webhook_deliveries_webhook_activity" in mig_0043
        and "webhook_deliveries_test_activity" in mig_0043
        and "webhook_deliveries_delivering_lock" in mig_0043
        and ".onConflictDoNothing()" in wh_enqueue
        and expire_revert_at >= 0
        and expire_on_act_at > expire_revert_at
        and "onActivity(tx, input.activityId)" not in ws_create_svc
    )
    m35_worker_skip_locked_and_circuit_breaker = (
        '.for("update", { skipLocked: true })' in wh_drain
        and "lte(webhookDeliveries.lockedUntil" in wh_drain
        and '"webhook_disabled"' in wh_attempt
        and "skipCircuitBreaker: true" in wh_attempt
        and "consecutiveFailures: 0" in wh_finalize
        and 'delivery.event === "webhook.test"' in wh_finalize
        and "AUTO_DISABLE_AFTER_FAILURES" in wh_finalize
        and '"consecutive_failures"' in wh_finalize
        and "else if (existing.enabled)" in wh_update
        and "interval '30 days'" in wh_prune
        and "rerun = true" in wh_index
        and "if (pruning) return;" in wh_index
    )

    # M36: avatar upload / orphan-sweep claim-first lifecycle. Every guard is read
    # from the service, its background scheduler, and the Problem route, so dropping
    # a claim, a status predicate or the overlap guard flips the bounded model.
    av_src = read_text("apps/server/src/features/avatars/service.ts")
    av_rest_src = read_text("apps/server/src/features/avatars/rest.ts")
    sweep_src = read_text("apps/server/src/platform/object-sweep.ts")
    av_discard_fn = slice_between(
        sweep_src, "export async function discardObject(", "export async function sweepOrphanObjects("
    )
    av_upload_fn = slice_between(av_src, "async upload(humanId, data)", "async remove(humanId)")
    av_sweep_fn = slice_between(
        sweep_src, "export async function sweepOrphanObjects(", "export function startObjectSweeps("
    )
    av_activate = slice_between(av_upload_fn, ".update(storedObjects)", "await tx.update(humans)")
    av_claim = slice_between(av_sweep_fn, ".update(storedObjects)", "const rows = await db")
    av_sweeper = slice_between(sweep_src, "export function startObjectSweeps(")

    av_claim_at = av_sweep_fn.find(".update(storedObjects)")
    av_discard_at = av_sweep_fn.find("discardObject(db, store")
    av_blob_delete_at = av_discard_fn.find("await store.delete(row.key)")
    av_row_delete_at = av_discard_fn.find(".delete(storedObjects)")
    m36_sweep_claims_before_delete = (
        av_claim_at >= 0
        and av_discard_at > av_claim_at
        and av_blob_delete_at >= 0
        and av_row_delete_at > av_blob_delete_at
        and 'status: "deleted"' in av_claim
        and "deletedAt: sql`now()`" in av_claim
        and 'eq(storedObjects.status, "pending")' in av_claim
        and "statement_timestamp() - interval '15 minutes'" in av_claim
        and "where(eq(storedObjects.status, \"deleted\"))" in av_sweep_fn
        and ".orderBy(storedObjects.id)" in av_sweep_fn
    )
    m36_pending_only_activation = (
        'eq(storedObjects.status, "pending")' in av_activate
        and "returning({ id: storedObjects.id })" in av_activate
    )
    m36_zero_row_clean_error = (
        "activated === undefined" in av_activate
        and 'throw new AvatarsError("avatar_upload_expired")' in av_activate
        and 'avatar_upload_expired: 409' in av_rest_src
    )
    m36_discard_returning_count = (
        "returning({ id: storedObjects.id })" in av_discard_fn
        and "deleted.length > 0" in av_discard_fn
    )
    m36_overlap_guard = (
        "let sweeping = false" in av_sweeper
        and "if (sweeping) return;" in av_sweeper
        and ".finally(() => {" in av_sweeper
        and "sweeping = false" in av_sweeper
    )

    # --- M37 (#175): atomic issue creation with optional assignee and labels ---
    create_issue_fn = slice_between(
        proj_src, "async createIssue(actorArg, projectId, input)", "async updateIssue(actorArg, issueId, input)"
    )
    require_project_labels_fn = slice_between(
        proj_src, "async function requireProjectLabels(", "async function requireLabel("
    )
    create_issue_contract = slice_between(
        pj_contract, "export const CreateIssueRequest =", '.meta({ id: "CreateIssueRequest" })'
    )
    create_issue_mcp = slice_between(mcp_src, "create_issue: async (actor, args)", "update_issue: async")
    issue_create_kinds = slice_between(proj_rest_src, "const issueCreateKinds =", "] as const;")
    m37_single_transaction = "db.transaction(async (tx)" in create_issue_fn
    m37_assignee_in_tx = (
        "validateAssignee(tx, project.workspaceId, input.assignee)" in create_issue_fn
        and "assigneeType: input.assignee?.type ?? null" in create_issue_fn
        and "assigneeId: input.assignee?.id ?? null" in create_issue_fn
        and "assignee: resolvedAssignee" in create_issue_fn
    )
    m37_labels_in_tx = (
        "requireProjectLabels(tx, projectId, requestedLabelIds)" in create_issue_fn
        and "tx.insert(issueLabels)" in create_issue_fn
        and 'throw new ProjectsError("label_not_found")' in require_project_labels_fn
        and "eq(projectLabels.projectId, projectId)" in require_project_labels_fn
        and "rows.length !== labelIds.size" in require_project_labels_fn
    )
    m37_contract_surface = (
        "assignee: Assignee.nullable().optional()" in create_issue_contract
        and "labelIds: z.array(" in create_issue_contract
    )
    m37_mcp_surface = (
        "assignee(args.assignee)" in create_issue_mcp and "labelIds(args.labelIds)" in create_issue_mcp
    )
    m37_problem_details = (
        '"assignee_not_found"' in issue_create_kinds and '"label_not_found"' in issue_create_kinds
    )

    # --- M38 (#177): project attachment upload claim-first activation + references ---
    att_src = read_text("apps/server/src/features/attachments/service.ts")
    att_rest_src = read_text("apps/server/src/features/attachments/rest.ts")
    att_schema_src = read_text("apps/server/src/db/schema.ts")
    att_upload_fn = slice_between(
        att_src, "async upload(actor, projectId, file)", "async download(actor, projectId, attachmentId)"
    )
    att_tx_fn = slice_between(att_upload_fn, "db.transaction(async (tx)", "} catch (error)")
    att_refs_table = slice_between(
        att_schema_src, "export const attachmentReferences = pgTable(", "const projectActivityTypesSql"
    )
    m38_pending_only_activation = (
        'eq(storedObjects.status, "pending")' in att_tx_fn
        and "returning({ id: storedObjects.id })" in att_tx_fn
    )
    m38_attachment_row_in_tx = (
        ".insert(attachments)" in att_tx_fn
        and "unreferencedAt: sql`now()`" in att_tx_fn
    )
    m38_zero_row_clean_error = (
        "activated === undefined" in att_tx_fn
        and 'throw new AttachmentsError("attachment_upload_expired")' in att_tx_fn
        and "attachment_upload_expired: 409" in att_rest_src
    )
    m38_unique_reference = (
        'uniqueIndex("one_reference_per_holder_attachment")' in att_refs_table
        and re.search(
            r"\.on\(\s*t\.holderType,\s*t\.holderId,\s*t\.attachmentId,?\s*\)",
            att_refs_table,
        )
        is not None
    )
    m38_reference_cascade = (
        '.references(() => attachments.id, { onDelete: "cascade" })' in att_refs_table
    )

    # --- M39 (#179): row-locked reference sync, 24h grace sweep, Trash/purge cleanup ---
    att_sync_fn = slice_between(
        att_src, "async syncReferences(tx, input)", "async listMetadata(tx, holders)"
    )
    att_purge_fn = slice_between(
        att_src, "async purgeHolders(tx, holders)", "async sweepUnreferenced()"
    )
    att_sweep_fn = att_src[att_src.index("async sweepUnreferenced()") :]
    att_reclaim_fn = slice_between(
        att_src, "async function reclaimMany(", "export function createAttachmentsService"
    )
    att_index_src = read_text("apps/server/src/features/attachments/index.ts")
    project_src = read_text("apps/server/src/features/projects/service.ts")
    purge_fn = slice_between(project_src, "async purgeExpiredTrash()", "async createIssue(")
    restore_fn = slice_between(project_src, "async restoreIssue(", "async listTrash(")
    delete_fn = slice_between(project_src, "async deleteIssue(", "async restoreIssue(")
    contract_project_src = read_text("packages/contract/src/projects.ts")
    mcp_tools_src = read_text("packages/contract/src/mcp-tools.ts")
    openapi_src = read_text("contract/openapi.json")
    mcp_contract_src = read_text("contract/mcp-tools.json")
    m39_sync_row_lock = (
        '.for("update", { of: attachments })' in att_sync_fn
        and ".orderBy(attachments.id)" in att_sync_fn
    )
    m39_active_only = (
        'row.status === "active"' in att_sync_fn
        and "row.projectId === input.projectId" in att_sync_fn
    )
    m39_dedupe = ".onConflictDoNothing()" in att_sync_fn
    m39_unref_clear = "unreferencedAt: null" in att_sync_fn
    m39_unref_reset = (
        "unreferencedAt: sql`statement_timestamp()`" in att_sync_fn
        and "notExists(" in att_sync_fn
    )
    m39_sweep_lock_expiry = (
        '.for("update")' in att_sweep_fn and "interval '24 hours'" in att_sweep_fn
    )
    m39_sweep_recheck = (
        "reclaimMany(tx, rows)" in att_sweep_fn
        and "attachmentReferences.attachmentId" in att_reclaim_fn
        and "!referenced.has(row.id)" in att_reclaim_fn
    )
    m39_atomic_reclaim = (
        "reclaimMany(tx, rows)" in att_sweep_fn
        and "await reclaimMany(tx," in att_purge_fn
        and ".delete(attachments)" in att_reclaim_fn
        and ".update(storedObjects)" in att_reclaim_fn
        and 'status: "deleted"' in att_reclaim_fn
    )
    m39_purge_issue_lock = '.for("update", { skipLocked: true })' in purge_fn
    m39_purge_holders = (
        '.for("update", { of: attachments })' in att_purge_fn
        and "await tx.delete(attachmentReferences)" in att_purge_fn
        and "await reclaimMany(tx," in att_purge_fn
        and "attachmentReferences.attachmentId" in att_reclaim_fn
        and "attachmentSeams.purgeHolders(tx, attachmentHolders)" in purge_fn
    )
    m39_sync_lock_union = (
        "[...new Set([...wanted, ...existingIds])].toSorted()" in att_sync_fn
        and "inArray(attachments.id, candidateIds)" in att_sync_fn
        and ".orderBy(attachments.id)" in att_sync_fn
    )
    m39_purge_single_batch = (
        "const attachmentHolders:" in purge_fn
        and "attachmentHolders.push(" in purge_fn
        and purge_fn.count("attachmentSeams.purgeHolders(tx, attachmentHolders)") == 1
        and purge_fn.index("attachmentHolders.push(")
        < purge_fn.index("attachmentSeams.purgeHolders(tx, attachmentHolders)")
    )
    m39_knowledge_noop_metadata = (
        'unchanged.attachments = await metadataFor(tx, "knowledge", entryId);' in project_src
    )
    m39_trash_preserve = (
        "THIRTY_DAYS_AGO" in purge_fn
        and "issue_purged" in restore_fn
        and "attachment" not in delete_fn
    )
    m39_holder_before_attachment = (
        project_src.count("await syncBody(tx, {") >= 5
        and "attachmentSeams.purgeHolders(tx, attachmentHolders)" in purge_fn
        and purge_fn.index(".for(\"update\", { skipLocked: true })")
        < purge_fn.index("attachmentSeams.purgeHolders(tx, attachmentHolders)")
    )
    m39_metadata_rest_mcp = (
        "attachments: z.array(AttachmentMetadata)" in contract_project_src
        and all(
            schema in mcp_tools_src
            for schema in ("IssueDetail", "IssueCommentsResponse", "KnowledgeEntry")
        )
        and '"attachments"' in openapi_src
        and '"attachments"' in mcp_contract_src
    )
    m39_background_overlap = (
        "if (sweeping) return;" in att_index_src and "setInterval(" in att_index_src
    )

    # #181: the invitation form's Human suggestions must not become an installation
    # directory. The decision lives in the workspaces service; the route, shared
    # contract and generated contract are read too, so deleting any of them fails M40.
    ws_rest_181 = read_text("apps/server/src/features/workspaces/rest.ts")
    ws_contract_181 = read_text("packages/contract/src/workspaces.ts")
    openapi_181 = read_text("contract/openapi.json")
    suggest_fn = slice_between(ws_src, "async suggestHumans(", "\n    async create(")
    suggest_kinds = slice_between(ws_rest_181, "const suggestKinds", "const createKinds")
    m40_account = "requireAccount(account)" in suggest_fn
    m40_workspace_404 = (
        "readSharedWorkspace(tx, workspaceId)" in suggest_fn
        and "readMembership(" in suggest_fn
        and '"workspace_not_found"' in suggest_fn
    )
    m40_capability_gate = (
        "!membership.isOwner" in suggest_fn and "!membership.canInviteMembers" in suggest_fn
    )
    m40_admin_branch = (
        "!account?.isSystemAdministrator" in suggest_fn
        and "isSystemAdministrator" in suggest_fn
    )
    m40_co_workspace = (
        "coWorkspaceHumans" in suggest_fn
        and "inArray(humans.id, coWorkspaceHumans)" in suggest_fn
    )
    m40_active_only = "isNull(humans.deactivatedAt)" in suggest_fn
    m40_exclude_members = "notInArray(humans.id, currentMembers)" in suggest_fn
    m40_bounded = ".limit(20)" in suggest_fn
    m40_http_401 = '"not_signed_in"' in suggest_kinds
    m40_route = (
        'path: "/api/workspaces/{workspaceId}/human-suggestions"' in ws_rest_181
        and "service.suggestHumans(" in ws_rest_181
    )
    m40_contract = all(
        name in ws_contract_181
        for name in ("HumanSuggestionsQuery", "HumanSuggestion", "HumanSuggestionsResponse")
    )
    m40_openapi = "/api/workspaces/{workspaceId}/human-suggestions" in openapi_181
    # #183 (#183 human handles and @mentions): the handle column is backfilled
    # before it becomes NOT NULL, and mention delivery is gated on a freshly
    # computed diff, live project Read access, and one row per activity.
    mig_handle = read_text("db/migrations/0047_adorable_hammerhead.sql")
    mig_backfill = read_text("db/migrations/0048_backfill_human_handles.sql")
    mentions_src = read_text("apps/server/src/features/notifications/mentions.ts")
    notif_create_fn = slice_between(notif_src, "const createForActivity: NotifyActivity", "const notificationColumns")
    notif_readable_fn = slice_between(notif_src, "const readableAccess =", "export function createNotificationsService")
    m41_handle_check = (
        "humans_handle_valid" in schema_src
        and "humans_handle_valid" in mig_handle
        and "char_length" in mig_handle
    )
    m41_handle_unique = (
        "humans_handle_unique" in schema_src
        and 'lower("handle")' in mig_handle
        and "lower" in mig_backfill
    )
    m41_backfill_before_not_null = (
        "orrery_human_handle_for" in mig_backfill
        and mig_backfill.index("UPDATE humans") < mig_backfill.index("SET NOT NULL")
        and "CREATE TRIGGER humans_assign_handle" in mig_backfill
    )
    m41_mention_diff = (
        "newlyAddedMentions(" in proj_src
        and "extractMentionHandles(" in proj_src
        and "newlyAddedMentions" in mentions_src
    )
    m41_ignore_non_text = all(
        marker in mentions_src
        for marker in ("FENCED_CODE", "INLINE_CODE", "MARKDOWN_LINK", "EMAIL")
    )
    m41_mention_recipients = (
        "mentionHandles" in notif_create_fn
        and "lower(${humans.handle})" in notif_create_fn
        and "recipients.delete(input.actorHumanId)" in notif_create_fn
    )
    m41_live_read_gate = (
        "${workspaces.id} = ${projects.workspaceId}" in notif_readable_fn
        and "suspendedAt} is null" in notif_readable_fn
        and "readableAccess(humans.id)" in notif_create_fn
    )
    notif_contract_src = read_text("packages/contract/src/notifications.ts")
    m41_dedupe_per_event = (
        ".onConflictDoNothing()" in notif_create_fn
        and "one_notification_per_human_and_activity" in schema_src
        and "issue_mentioned" in notif_contract_src
    )

    # M42 (#195): Runner-host device-code enrollment, DB-time presence and
    # revocation cascades. Every transition guard is read from the live sources,
    # so deleting one flips the model to the unsafe transition relation.
    runners_src = read_text("apps/server/src/features/runners/service.ts")
    runners_rest_src = read_text("apps/server/src/features/runners/rest.ts")
    deact_runner_src = read_text("apps/server/src/features/deactivation/service.ts")
    ws_runner_src = read_text("apps/server/src/features/workspaces/service.ts")
    runners_schema_src = read_text("apps/server/src/db/schema.ts")
    runners_contract_src = read_text("packages/contract/src/runners.ts")
    runners_openapi_src = read_text("contract/openapi.json")
    m42_exchange_fn = slice_between(runners_src, "async exchangeDeviceCode(", "async registerRunner(")
    m42_approve_fn = slice_between(runners_src, "async approveDeviceCode(", "async exchangeDeviceCode(")
    m42_register_fn = slice_between(runners_src, "async registerRunner(", "async heartbeat(")
    m42_heartbeat_fn = slice_between(runners_src, "async heartbeat(", "async listWorkspaceRunners(")
    m42_fleet_fn = slice_between(runners_src, "async listWorkspaceRunners(", "async revokeRunnerHost(")
    m42_host_revoke_fn = slice_between(runners_src, "async revokeRunnerHost(", "export type RunnersService")
    m42_host_cascade_fn = slice_between(runners_src, "export async function revokeRunnerHostsForHuman(")
    m42_member_cascade_fn = slice_between(runners_src, "export async function revokeWorkspaceRunnersForMember(")
    m42_deact_fn = slice_between(deact_runner_src, "async deactivate(", "\n    async reactivate(")
    m42_end_membership_fn = slice_between(ws_runner_src, "async function endMembership(", "\n  }\n\n  return {")
    m42_code_expiry_decl = slice_between(
        runners_src, "const deviceCodeNotExpired", "const attemptWindowExpired"
    )

    m42_exchange_for_update = (
        'for("update")' in m42_exchange_fn
        and "deviceCodeHash, tokenHash(input.deviceCode)" in m42_exchange_fn
    )
    m42_single_use = (
        'error: "device_code_used"' in m42_exchange_fn
        and "usedAt: sql`statement_timestamp()`" in m42_exchange_fn
    )
    m42_db_time_expiry = (
        "notExpired: deviceCodeNotExpired" in m42_exchange_fn
        and "statement_timestamp()" in m42_code_expiry_decl
    )
    m42_verifier_binding = "verifierHash !== tokenHash(input.verifier)" in m42_exchange_fn
    m42_capped_increments = (
        "least(" in m42_exchange_fn and "least(" in m42_approve_fn
    )
    m42_attempt_window = (
        "expired: attemptWindowExpired" in m42_approve_fn
        and ".delete(runnerDeviceCodeAttempts)" in m42_approve_fn
    )
    m42_approve_post = (
        'path: "/api/runners/device-codes/{userCode}/approve"' in runners_rest_src
        and 'method: "post"'
        in slice_between(runners_rest_src, "const approveDeviceCode", "const exchangeDeviceCode")
    )
    m42_workspace_before_project = (
        "canSeeWorkspace(tx, input.workspaceId" in m42_register_fn
        and m42_register_fn.find("canSeeWorkspace(tx, input.workspaceId")
        < m42_register_fn.find(".from(projects)")
    )
    m42_project_access = (
        "projectAccessCeiling(tx, input.workspaceId, host.humanId" in m42_register_fn
        and 'throw new RunnersError("project_not_found")' in m42_register_fn
    )
    m42_same_human_agent = (
        "and(eq(agents.id, input.agentId), eq(agents.humanId, host.humanId))" in m42_register_fn
        and 'throw new RunnersError("agent_not_found")' in m42_register_fn
    )
    m42_db_time_presence = (
        "runnerPresenceSql" in runners_src
        and "statement_timestamp()" in slice_between(runners_src, "export const runnerPresenceSql", "const runnerFields")
        and '"revoked_at"' in runners_schema_src
    )
    m42_heartbeat_revoked_401 = (
        'throw new RunnersError("runner_revoked")' in m42_heartbeat_fn
        and 'runner_revoked: 401' in runners_rest_src
    )
    m42_heartbeat_access_401 = (
        "projectAccessCeiling(tx, runner.workspaceId, host.humanId" in m42_heartbeat_fn
    )
    m42_slot_count_400 = (
        'throw new RunnersError("slot_count_invalid")' in m42_heartbeat_fn
        and 'slot_count_invalid: 400' in runners_rest_src
    )
    m42_fleet_read_filter = (
        'hasAccess(ceiling.get(row.runner.projectId), "read", projectAccessAtLeast)'
        in m42_fleet_fn
    )
    m42_deactivation_revoke_hosts = "revokeRunnerHostsForHuman(tx, humanId)" in m42_deact_fn
    m42_host_cascade_runners = (
        m42_host_cascade_fn.find(".update(runners)") >= 0
        and m42_host_cascade_fn.find(".update(runners)")
        < m42_host_cascade_fn.find(".update(runnerHosts)")
    )
    m42_member_revoke_runners = (
        "revokeMemberWorkspaceRunners?.(tx, workspaceId, humanId)" in m42_end_membership_fn
    )
    m42_member_scope_only = (
        ".update(runners)" in m42_member_cascade_fn
        and ".update(runnerHosts)" not in m42_member_cascade_fn
        and "eq(runners.workspaceId, workspaceId)" in m42_member_cascade_fn
    )
    m42_host_revoke_in_tx = (
        "db.transaction(" in m42_host_revoke_fn
        and ".update(runners)" in m42_host_revoke_fn
        and ".update(runnerHosts)" in m42_host_revoke_fn
    )
    m42_contract_and_contract_surface = (
        "WorkspaceRunnersFleet" in runners_contract_src
        and '"/api/runners/{runnerId}/heartbeat"' in runners_openapi_src
        and '"/api/workspaces/{workspaceId}/runners"' in runners_openapi_src
    )

    return {
        "m1_serialized": m1_lock_in_service and m1_last_owner_check and m1_db_advisory_lock and m1_db_trigger,
        "m2a_supersedes_failed": m2a_supersedes_failed,
        "m2b_guarded": m2b_ws_guarded and m2b_inv_guarded,
        "m3_serialized": m3_email_check_in_tx and m3_per_email_lock,
        "m3_resend_serialized": m3_resend_serialized,
        "m4_issue_for_update": m4_issue_for_update,
        "m4_knowledge_for_update": m4_knowledge_for_update,
        "m5_safe_rotation": m5_no_predelete and m5_post_retire_guarded,
        "m6_singleton_tx": m6_singleton_tx,
        "m7_non_member_404": m7_non_member_404,
        "m8_access_serialized": m8_access_serialized,
        "m9_offer_persisted": m9_offer_persisted,
        "m9_resend_validates": m9_resend_validates,
        "m9_resend_rejects_member": ordered(resend_fn, "lockWorkspaceForMutation(tx, workspaceId)", "requireRecipientNotMember(tx, workspaceId, row.email)", ".update(workspaceInvitations)", "insert(workspaceInvitations)"),
        "m9_preview_validates": m9_preview_validates,
        "m9_existing_applies": m9_existing_applies,
        "m9_registration_applies": m9_registration_applies,
        "m9_grant_writer": m9_grant_writer,
        "m9_apply_validates": m9_apply_validates,
        "m9_resend_copies": m9_resend_copies,
        "m9_owner_stale_supersedes": m9_owner_stale_supersedes,
        "m7_endpoint_reads": m7_endpoint_reads,
        "m7_get_404": m7_get_404,
        "m7_read_membership_404": m7_read_membership_404,
        "m7_require_owner_404": m7_require_owner_404,
        "m7_require_inviter_404": m7_require_inviter_404,
        "m10_owner_only_manager": m10_owner_only_manager,
        "m10_no_owner_modify": m10_no_owner_modify,
        "m10_no_self_modify": m10_no_self_modify,
        "m10_capability_ceiling": m10_capability_ceiling,
        "m10_remove_authority": m10_remove_authority,
        "m10_remove_protected": m10_remove_protected,
        "m10_project_manage_guard": m10_project_manage_guard,
        "m10_invite_scope": m10_invite_scope,
        "m10_resend_scope": m10_resend_scope,
        "m10_revoke_scope": m10_revoke_scope,
        "m10_redemption_membership": m10_redemption_membership,
        "m10_redemption_capability": m10_redemption_capability,
        "m10_redemption_verified": m10_redemption_verified,
        "m10_redemption_project_scope": m10_redemption_project_scope,
        "m10_redeem_checks_inviter": m10_redeem_checks_inviter,
        "m10_accept_redeems": m10_accept_redeems,
        "m10_register_redeems": m10_register_redeems,
        "m10_list_scoping": m10_list_scoping,
        "m10_dead_offer_supersedes": m10_dead_offer_supersedes,
        "m10_self_revoke": m10_self_revoke,
        "m11_revocation": m11_revocation,
        "m11_membership": m11_membership,
        "m11_issue_ceiling": m11_issue_ceiling,
        "m11_single_event": m11_single_event,
        "m11_expiry": m11_expiry,
        "m11_never_skips_expiry_only": m11_never_skips_expiry_only,
        "m11_scope": m11_scope,
        "m11_project_scope": m11_project_scope,
        "m11_ceiling": m11_ceiling,
        "m11_owner_isolation": m11_owner_isolation,
        "m11_key_hash_only": m11_key_hash_only,
        "m11_events": m11_events,
        "m11_events_without_secret": m11_events_without_secret,
        "m11_member_removal_revokes_keys": m11_member_removal_revokes_keys,
        "m11_issue_serialized": m11_issue_serialized,
        "m11_repeatable_read_auth": m11_repeatable_read_auth,
        "m11_key_project_scope_db": m11_key_project_scope_db,
        "m12_agent_scope": m12_agent_scope,
        "m12_shared_gate": m12_shared_gate,
        "m12_agent_actor": m12_agent_actor,
        "m12_actor_constraint": m12_actor_constraint,
        "m12_mcp_reauth": m12_mcp_reauth,
        "m12_tools_exist": m12_tools_exist,
        "m12_no_admin_tools": m12_no_admin_tools,
        "m12_rest_bearer": m12_rest_bearer,
        "m12_rest_admin_session": m12_rest_admin_session,
        "m12_list_scope": m12_list_scope,
        "m13_session_only": m13_session_only,
        "m13_workspace_404": m13_workspace_404,
        "m13_delegate_scope": m13_delegate_scope,
        "m13_owner_keys": m13_owner_keys,
        "m13_project_404": m13_project_404,
        "m13_manage_access": m13_manage_access,
        "m13_activity_granted": m13_activity_granted,
        "m13_admin_only": m13_admin_only,
        "m13_installation_scope": m13_installation_scope,
        "m13_no_secret": m13_no_secret,
        "m14_db_identity": m14_db_identity,
        "m14_identity_key": m14_identity_key,
        "m14_conflict": m14_conflict,
        "m14_explicit_scope": m14_explicit_scope,
        "m14_child_link": m14_child_link,
        "m14_child_scope": m14_child_scope,
        "m14_serialized": m14_serialized,
        "m14_model_change": m14_model_change,
        "m14_unknown": m14_unknown,
        "m14_reported_contract": m14_reported_contract,
        "m14_no_lease": m14_no_lease,
        "m14_human_scope": m14_human_scope,
        "m14_adapters": m14_adapters,
        "m14_tool": m14_tool,
        "m15_token_hash_only": m15_token_hash_only,
        "m15_unverified_no_mail": m15_unverified_no_mail,
        "m15_uniform_response": m15_uniform_response,
        "m15_failed_send_deletes_token": m15_failed_send_deletes_token,
        "m15_single_use": m15_single_use,
        "m15_db_time_expiry": m15_db_time_expiry,
        "m15_one_tx": m15_one_tx,
        "m15_sessions_cleared": m15_sessions_cleared,
        "m15_agent_keys_untouched": m15_agent_keys_untouched,
        "m15_scope_untouched": m15_scope_untouched,
        "m15_events_without_secret": m15_events_without_secret,
        "m15_local_no_smtp": m15_local_no_smtp,
        "m15_http_problems": m15_http_problems,
        "m15_revokes_pending_tokens": m15_revokes_pending_tokens,
        "m15_admin_only_local": m15_admin_only_local,
        "m16_serialized": m16_serialized,
        "m16_source_ownership": m16_source_ownership,
        "m16_revoked_refused": m16_revoked_refused,
        "m16_expired_refused": m16_expired_refused,
        "m16_workspace_access": m16_workspace_access,
        "m16_same_agent_workspace": m16_same_agent_workspace,
        "m16_independent_secret": m16_independent_secret,
        "m16_independent_expiry": m16_independent_expiry,
        "m16_grants_capped": m16_grants_capped,
        "m16_no_cascade": m16_no_cascade,
        "m16_event": m16_event,
        "m16_history_surface": m16_history_surface,
        "m16_http_problems": m16_http_problems,
        "m17_unique_index": m17_unique_index,
        "m17_issue_lock": m17_issue_lock,
        "m17_lazy_expiry": m17_lazy_expiry,
        "m17_db_time_lease": m17_db_time_lease,
        "m17_progress_independent": m17_progress_independent,
        "m17_fenced_write": m17_fenced_write,
        "m17_gate_no_claim": m17_gate_no_claim,
        "m17_no_nested_tx": m17_no_nested_tx,
        "m17_renew_active": m17_renew_active,
        "m17_recheck_access": m17_recheck_access,
        "m17_session_identity": m17_session_identity,
        "m17_helper_shares": m17_helper_shares,
        "m17_ready_db_time": m17_ready_db_time,
        "m17_unfenced": m17_unfenced,
        "m17_adapters": m17_adapters,
        "m17_tools": m17_tools,
        "m17_problems": m17_problems,
        "m18_resume_read_only": m18_resume_read_only,
        "m18_resume_db_time": m18_resume_db_time,
        "m18_resume_keeps_progress": m18_resume_keeps_progress,
        "m18_stale_rejected": m18_stale_rejected,
        "m18_db_time_liveness": m18_db_time_liveness,
        "m18_reacquire_available": m18_reacquire_available,
        "m18_reacquire_expired_only": m18_reacquire_expired_only,
        "m18_reacquire_carries_progress": m18_reacquire_carries_progress,
        "m18_reacquire_fresh_session": m18_reacquire_fresh_session,
        "m18_idempotent": m18_idempotent,
        "m18_adapters": m18_adapters,
        "m18_http_problems": m18_http_problems,
        "m18_session_fence": m18_session_fence,
        "m18_closed_refused": m18_closed_refused,
        "m18_update_db_time": m18_update_db_time,
        "m18_find_active_db_time": m18_find_active_db_time,
        "m19_release_in_remove": m18_release_in_remove,
        "m19_release_in_leave": m18_release_in_leave,
        "m19_active_only": m18_active_only,
        "m19_release_status_guard": m18_release_status_guard,
        "m19_membership_lock": m18_membership_lock,
        "m19_issue_lock_order": m18_issue_lock_order,
        "m19_no_nested_tx": m18_no_nested_tx,
        "m19_recheck_membership": m18_recheck_membership,
        "m19_personal_scope": m18_personal_scope,
        "m19_revoke_keys": m18_revoke_keys,
        "m19_revoke_grants": m18_revoke_grants,
        "m19_last_owner_leave": m18_last_owner_leave,
        "m19_personal_not_leavable": m18_personal_not_leavable,
        "m19_distinct_events": m18_distinct_events,
        "m19_single_tx": m18_single_tx,
        "m19_attribution_kept": m18_attribution_kept,
        "m19_leave_route": m18_leave_route,
        "m20_statuses": m20_statuses,
        "m20_issue_lock": m20_issue_lock,
        "m20_db_time": m20_db_time,
        "m20_answer_evaluates_deadline": m20_answer_evaluates_deadline,
        "m20_exact_once": m20_exact_once,
        "m20_release_pause": m20_release_pause,
        "m20_paused_unblock": m20_paused_unblock,
        "m20_needs_sync": m20_needs_sync,
        "m20_no_nested": m20_no_nested,
        "m20_human_only": m20_human_only,
        "m20_email_after_commit": m20_email_after_commit,
        "m20_history": m20_history,
        "m20_claim_bounded": m20_claim_bounded,
        "m20_adapters": m20_adapters,
        "m20_lock_order": m20_lock_order,
        "m20_non_enumeration": m20_non_enumeration,
        "m20_scoped_list": m20_scoped_list,
        "m20_db_time_reads": m20_db_time_reads,
        "m20_ask_scope": m20_ask_scope,
        "m20_boundary_guard": m20_boundary_guard,
        "m20_read_tool": m20_read_tool,
        "m20_feature_seams": m20_feature_seams,
        "m21_source_owner": m21_source_owner,
        "m21_two_party": m21_two_party,
        "m21_dest_authority": m21_dest_authority,
        "m21_recheck_source": m21_recheck_source,
        "m21_recheck_authority": m21_recheck_authority,
        "m21_recheck_workspace": m21_recheck_workspace,
        "m21_active_work": m21_active_work,
        "m21_db_time_live": m21_db_time_live,
        "m21_db_time_expiry": m21_db_time_expiry,
        "m21_single_tx": m21_single_tx,
        "m21_lock_first": m21_lock_first,
        "m21_guard_order": m21_guard_order,
        "m21_issue_lock": m21_issue_lock,
        "m21_key_cleanup": m21_key_cleanup,
        "m21_grant_cleanup": m21_grant_cleanup,
        "m21_offer_cleanup": m21_offer_cleanup,
        "m21_grant_rebuild": m21_grant_rebuild,
        "m21_grant_events": m21_grant_events,
        "m21_receipt_events": m21_receipt_events,
        "m21_source_events_scoped": m21_source_events_scoped,
        "m21_preserve_identity": m21_preserve_identity,
        "m21_preview": m21_preview,
        "m21_http_problems": m21_http_problems,
        "m21_human_only": m21_human_only,
        "m21_authorization_persisted": m21_authorization_persisted,
        "m21_dest_membership_preview": m21_dest_membership_preview,
        "m21_dest_membership_complete": m21_dest_membership_complete,
        "m21_authorize_redaction": m21_authorize_redaction,
        "m21_receiver_preview": m21_receiver_preview,
        "m21_receiver_authority": m21_receiver_authority,
        "m21_receiver_recipient": m21_receiver_recipient,
        "m21_expire_lapsed": m21_expire_lapsed,
        "m21_pending_offers_only": m21_pending_offers_only,
        "m21_revoke_siblings": m21_revoke_siblings,
        "m21_accept_membership": m21_accept_membership,
        "m22_deactivated_column": m22_deactivated_column,
        "m22_suspended_column": m22_suspended_column,
        "m22_last_admin_guard": m22_last_admin_guard,
        "m22_one_tx": m22_one_tx,
        "m22_sessions_deleted": m22_sessions_deleted,
        "m22_keys_revoked": m22_keys_revoked,
        "m22_claims_released": m22_claims_released,
        "m22_grants_revoked": m22_grants_revoked,
        "m22_membership_suspended": m22_membership_suspended,
        "m22_no_restore": m22_no_restore,
        "m22_events": m22_events,
        "m22_auth_login": m22_auth_login,
        "m22_auth_session": m22_auth_session,
        "m22_auth_key": m22_auth_key,
        "m22_membership_checks": m22_membership_checks,
        "m22_trigger": m22_trigger,
        "m22_http_problems": m22_http_problems,
        "m22_account_lock": m22_account_lock,
        "m22_membership_lock": m22_membership_lock,
        "m22_lock_order": m22_lock_order,
        "m22_claim_account_lock": m22_claim_account_lock,
        "m22_key_issuance_guard": m22_key_issuance_guard,
        "m22_reset_guard": m22_reset_guard,
        "m22_invitation_recheck": m22_invitation_recheck,
        "m22_ownerless_refusal": m22_ownerless_refusal,
        "m23_contract": m23_contract,
        "m23_schema": m23_schema,
        "m23_project_manage": m23_project_manage,
        "m23_issue_contribute": m23_issue_contribute,
        "m23_tighten_only": m23_tighten_only,
        "m23_no_agent": m23_no_agent,
        "m23_effective": m23_effective,
        "m23_lease_unclipped": m23_lease_unclipped,
        "m23_reacquire_deadline": m23_reacquire_deadline,
        "m23_freeze": m23_freeze,
        "m23_branch": m23_branch,
        "m23_fallback_keeps_live_claim": m23_fallback_keeps_live_claim,
        "m23_db_time": m23_db_time,
        "m23_authorized_only": m23_authorized_only,
        "m23_follow_up": m23_follow_up,
        "m23_no_enlarge": m23_no_enlarge,
        "m23_activity": m23_activity,
        "m23_problems": m23_problems,
        "m24_shared_source": m24_shared_source,
        "m24_recheck_shared_owner": m24_recheck_shared_owner,
        "m24_same_workspace": m24_same_workspace,
        "m24_visibility": m24_visibility,
        "m24_access_event_scope": m24_access_event_scope,
        "m24_grant_event_workspace": m24_grant_event_workspace,
        "m24_history_filter": m24_history_filter,
        "m24_history_project_filter": m24_history_project_filter,
        "m24_key_cleanup": m24_key_cleanup,
        "m24_grant_cleanup": m24_grant_cleanup,
        "m24_offer_cleanup": m24_offer_cleanup,
        "m24_pending_offers_only": m24_pending_offers_only,
        "m24_revoke_siblings": m24_revoke_siblings,
        "m24_grant_rebuild": m24_grant_rebuild,
        "m24_grant_events": m24_grant_events,
        "m24_receipt_events": m24_receipt_events,
        "m24_two_party": m24_two_party,
        "m24_authorize_redaction": m24_authorize_redaction,
        "m24_receiver_preview": m24_receiver_preview,
        "m24_receiver_authority": m24_receiver_authority,
        "m24_dest_membership_preview": m24_dest_membership_preview,
        "m24_dest_membership_complete": m24_dest_membership_complete,
        "m24_accept_membership": m24_accept_membership,
        "m24_dest_authority": m24_dest_authority,
        "m24_recheck_workspace": m24_recheck_workspace,
        "m24_active_work": m24_active_work,
        "m24_db_time_live": m24_db_time_live,
        "m24_db_time_expiry": m24_db_time_expiry,
        "m24_single_tx": m24_single_tx,
        "m24_lock_first": m24_lock_first,
        "m24_guard_order": m24_guard_order,
        "m24_issue_lock": m24_issue_lock,
        "m24_preserve_identity": m24_preserve_identity,
        "m24_expire_lapsed": m24_expire_lapsed,
        "m24_http_problems": m24_http_problems,
        "m24_human_only": m24_human_only,
        "m25_one_tx": m25_one_tx,
        "m25_lock_first": m25_lock_first,
        "m25_admin_recheck": m25_admin_recheck,
        "m25_shared_only": m25_shared_only,
        "m25_guard_bump": m25_guard_bump,
        "m25_self_guard": m25_self_guard,
        "m25_active_owner_guard": m25_active_owner_guard,
        "m25_target_active_guard": m25_target_active_guard,
        "m25_membership_guard": m25_membership_guard,
        "m25_promote": m25_promote,
        "m25_events": m25_events,
        "m25_history": m25_history,
        "m25_directory_scope": m25_directory_scope,
        "m25_human_only": m25_human_only,
        "m25_http_problems": m25_http_problems,
        "m25_notify_after_commit": m25_notify_after_commit,
        "m25_no_admin_grant": m25_no_admin_grant,
        "m25_no_key_revival": m25_no_key_revival,
        "m26_human_only": m26_human_only,
        "m26_lock_order": m26_lock_order,
        "m26_non_enum": m26_non_enum,
        "m26_idempotent": m26_idempotent,
        "m26_db_time_write": m26_db_time_write,
        "m26_activity_atomic": m26_activity_atomic,
        "m26_schema_check": m26_schema_check,
        "m27_no_self_link": m27_no_self_link,
        "m27_same_project": m27_same_project,
        "m27_project_lock": m27_project_lock,
        "m27_lock_order": m27_lock_order,
        "m27_cycle_bfs": m27_cycle_bfs,
        "m27_idempotent": m27_idempotent,
        "m27_ready_excludes": m27_ready_excludes,
        "m28_live_gate": m28_live_gate,
        "m28_no_lease_mutation": m28_no_lease_mutation,
        "m28_read_deactivation": m28_read_deactivation,
        "m28_read_non_enum": m28_read_non_enum,
        "m28_detail_bound": m28_detail_bound,
        "m28_schema_check": m28_schema_check,
        "m29_db_check": m29_db_check,
        "m29_assignee_validation": m29_assignee_validation,
        "m29_lock_order": m29_lock_order,
        "m29_strict_claim": m29_strict_claim,
        "m29_ready_filter": m29_ready_filter,
        "m29_contract_surface": m29_contract_surface,
        "m29_workspace_recheck": m29_workspace_recheck,
        "m30_six_states": m30_six_states,
        "m30_claim_to_in_progress": m30_claim_to_in_progress,
        "m30_revert_on_end": m30_revert_on_end,
        "m30_pause_and_lapsed_answer_revert": m30_pause_and_lapsed_answer_revert,
        "m30_completion_outcomes": m30_completion_outcomes,
        "m31_no_self_parent": m31_no_self_parent,
        "m31_same_project_parent": m31_same_project_parent,
        "m31_depth_one": m31_depth_one,
        "m31_trigger_lock_order": m31_trigger_lock_order,
        "m31_label_same_project": m31_label_same_project,
        "m31_label_schema_guards": m31_label_schema_guards,
        "m32_human_only_delete": m32_human_only_delete,
        "m32_active_session_guard": m32_active_session_guard,
        "m32_manage_restore_db_window": m32_manage_restore_db_window,
        "m32_scrub_preserves_tombstone": m32_scrub_preserves_tombstone,
        "m32_schema_and_read_exclusion": m32_schema_and_read_exclusion,
        "m33_human_session_only": m33_human_session_only,
        "m33_deactivated_refused": m33_deactivated_refused,
        "m33_live_membership_and_ceiling": m33_live_membership_and_ceiling,
        "m33_assigned_and_session_filters": m33_assigned_and_session_filters,
        "m33_questions_db_time_contribute": m33_questions_db_time_contribute,
        "m34_auth_boundary": m34_auth_boundary,
        "m34_per_issue_sweep_order": m34_per_issue_sweep_order,
        "m34_atomic_idempotent_schema": m34_atomic_idempotent_schema,
        "m34_live_access_non_enum": m34_live_access_non_enum,
        "m34_lossless_cursor_and_prune": m34_lossless_cursor_and_prune,
        "m35_owner_rbac_and_cap": m35_owner_rbac_and_cap,
        "m35_explicit_scope_and_transfer_non_widening": m35_explicit_scope_and_transfer_non_widening,
        "m35_secret_encryption_and_signing": m35_secret_encryption_and_signing,
        "m35_ssrf_dns_pinned": m35_ssrf_dns_pinned,
        "m35_atomic_outbox_and_single_enqueue": m35_atomic_outbox_and_single_enqueue,
        "m35_worker_skip_locked_and_circuit_breaker": m35_worker_skip_locked_and_circuit_breaker,
        "m36_sweep_claims_before_delete": m36_sweep_claims_before_delete,
        "m36_pending_only_activation": m36_pending_only_activation,
        "m36_zero_row_clean_error": m36_zero_row_clean_error,
        "m36_discard_returning_count": m36_discard_returning_count,
        "m36_overlap_guard": m36_overlap_guard,
        "m37_single_transaction": m37_single_transaction,
        "m37_assignee_in_tx": m37_assignee_in_tx,
        "m37_labels_in_tx": m37_labels_in_tx,
        "m37_contract_surface": m37_contract_surface,
        "m37_mcp_surface": m37_mcp_surface,
        "m37_problem_details": m37_problem_details,
        "m38_pending_only_activation": m38_pending_only_activation,
        "m38_attachment_row_in_tx": m38_attachment_row_in_tx,
        "m38_zero_row_clean_error": m38_zero_row_clean_error,
        "m38_unique_reference": m38_unique_reference,
        "m38_reference_cascade": m38_reference_cascade,
        "m39_sync_row_lock": m39_sync_row_lock,
        "m39_active_only": m39_active_only,
        "m39_dedupe": m39_dedupe,
        "m39_unref_clear": m39_unref_clear,
        "m39_unref_reset": m39_unref_reset,
        "m39_sweep_lock_expiry": m39_sweep_lock_expiry,
        "m39_sweep_recheck": m39_sweep_recheck,
        "m39_atomic_reclaim": m39_atomic_reclaim,
        "m39_purge_issue_lock": m39_purge_issue_lock,
        "m39_purge_holders": m39_purge_holders,
        "m39_trash_preserve": m39_trash_preserve,
        "m39_holder_before_attachment": m39_holder_before_attachment,
        "m39_sync_lock_union": m39_sync_lock_union,
        "m39_purge_single_batch": m39_purge_single_batch,
        "m39_knowledge_noop_metadata": m39_knowledge_noop_metadata,
        "m39_metadata_rest_mcp": m39_metadata_rest_mcp,
        "m39_background_overlap": m39_background_overlap,
        "m40_account": m40_account,
        "m40_workspace_404": m40_workspace_404,
        "m40_capability_gate": m40_capability_gate,
        "m40_admin_branch": m40_admin_branch,
        "m40_co_workspace": m40_co_workspace,
        "m40_active_only": m40_active_only,
        "m40_exclude_members": m40_exclude_members,
        "m40_bounded": m40_bounded,
        "m40_http_401": m40_http_401,
        "m40_route": m40_route,
        "m40_contract": m40_contract,
        "m40_openapi": m40_openapi,
        "m41_handle_check": m41_handle_check,
        "m41_handle_unique": m41_handle_unique,
        "m41_backfill_before_not_null": m41_backfill_before_not_null,
        "m41_mention_diff": m41_mention_diff,
        "m41_ignore_non_text": m41_ignore_non_text,
        "m41_mention_recipients": m41_mention_recipients,
        "m41_live_read_gate": m41_live_read_gate,
        "m41_dedupe_per_event": m41_dedupe_per_event,
        "m42_exchange_for_update": m42_exchange_for_update,
        "m42_single_use": m42_single_use,
        "m42_db_time_expiry": m42_db_time_expiry,
        "m42_verifier_binding": m42_verifier_binding,
        "m42_capped_increments": m42_capped_increments,
        "m42_attempt_window": m42_attempt_window,
        "m42_approve_post": m42_approve_post,
        "m42_workspace_before_project": m42_workspace_before_project,
        "m42_project_access": m42_project_access,
        "m42_same_human_agent": m42_same_human_agent,
        "m42_db_time_presence": m42_db_time_presence,
        "m42_heartbeat_revoked_401": m42_heartbeat_revoked_401,
        "m42_heartbeat_access_401": m42_heartbeat_access_401,
        "m42_slot_count_400": m42_slot_count_400,
        "m42_fleet_read_filter": m42_fleet_read_filter,
        "m42_deactivation_revoke_hosts": m42_deactivation_revoke_hosts,
        "m42_host_cascade_runners": m42_host_cascade_runners,
        "m42_member_revoke_runners": m42_member_revoke_runners,
        "m42_member_scope_only": m42_member_scope_only,
        "m42_host_revoke_in_tx": m42_host_revoke_in_tx,
        "m42_contract_and_contract_surface": m42_contract_and_contract_surface,
    }


def bfs_check(
    check_id: str,
    model: str,
    property_name: str,
    kind: str,
    initial_state: Any,
    next_states: Callable[[Any], list[tuple[str, Any]]],
    invariant: Callable[[Any], tuple[bool, str]],
    files: list[str],
    max_states: int = 50000,
) -> CheckResult:
    visited = {initial_state}
    queue = deque([(initial_state, [])])
    transitions = 0

    while queue and len(visited) < max_states:
        state, trace = queue.popleft()
        ok, reason = invariant(state)
        if not ok:
            return CheckResult(
                id=check_id,
                model=model,
                property_name=property_name,
                kind=kind,
                status="violated",
                states_explored=len(visited),
                transitions_explored=transitions,
                summary=reason,
                counterexample=trace,
                files=files,
            )
        for label, nxt in next_states(state):
            transitions += 1
            if nxt not in visited:
                visited.add(nxt)
                queue.append((nxt, trace + [label]))

    return CheckResult(
        id=check_id,
        model=model,
        property_name=property_name,
        kind=kind,
        status="verified",
        states_explored=len(visited),
        transitions_explored=transitions,
        summary=f"Verified across {len(visited)} reachable states ({transitions} transitions).",
        counterexample=[],
        files=files,
    )


def check_m1(facts: dict[str, Any]) -> CheckResult:
    serialized = facts["m1_serialized"]
    init = (frozenset({"u1", "u2"}), frozenset({"u3"}), None, ("idle", None), ("idle", None))

    def step_tx(state, tx_idx):
        owners, members, lock, tx1, tx2 = state
        me = "tx1" if tx_idx == 1 else "tx2"
        pc, target = tx1 if tx_idx == 1 else tx2
        out = []

        def set_tx(no, nm, nl, nt):
            return (no, nm, nl, nt, tx2) if tx_idx == 1 else (no, nm, nl, tx1, nt)

        if pc == "idle":
            for actor in ("u1", "u2", "u3"):
                for tgt in ("u1", "u2", "u3"):
                    out.append((f"{me}: begin removeMember({actor}, {tgt})", set_tx(owners, members, lock, ("want_remove", (actor, tgt)))))
                    out.append((f"{me}: begin appointOwner({actor}, {tgt})", set_tx(owners, members, lock, ("want_appoint", (actor, tgt)))))
        elif pc == "want_remove":
            if serialized:
                if lock is None:
                    out.append((f"{me}: acquire lock_workspace_ownership_writes()", set_tx(owners, members, me, ("locked_remove", target))))
            else:
                # Unserialized snapshot read: both tx1 and tx2 can observe len(owners)==2
                actor, tgt = target
                if actor in owners and (tgt in owners or tgt in members) and (tgt not in owners or len(owners) > 1):
                    out.append((f"{me}: snapshot read sees >1 owners [UNSERIALIZED]", set_tx(owners, members, lock, ("commit_unserialized_remove", tgt))))
                else:
                    out.append((f"{me}: reject remove", set_tx(owners, members, lock, ("idle", None))))
        elif pc == "commit_unserialized_remove":
            out.append((f"{me}: commit DELETE membership({target}) [UNSERIALIZED]", set_tx(owners - {target}, members - {target}, lock, ("idle", None))))
        elif pc == "locked_remove":
            actor, tgt = target
            if actor not in owners or (tgt not in owners and tgt not in members) or (tgt in owners and len(owners) <= 1):
                out.append((f"{me}: rollback remove({tgt})", set_tx(owners, members, None, ("idle", None))))
            else:
                out.append((f"{me}: commit remove({tgt})", set_tx(owners - {tgt}, members - {tgt}, None, ("idle", None))))
        elif pc == "want_appoint":
            if not serialized or lock is None:
                out.append((f"{me}: enter appointOwner", set_tx(owners, members, me if serialized else lock, ("locked_appoint", target))))
        elif pc == "locked_appoint":
            actor, tgt = target
            nl = None if serialized else lock
            if actor in owners and tgt in members:
                out.append((f"{me}: commit appoint({tgt})", set_tx(owners | {tgt}, members - {tgt}, nl, ("idle", None))))
            else:
                out.append((f"{me}: end appoint({tgt})", set_tx(owners, members, nl, ("idle", None))))
        return out

    def inv(state):
        owners, members, _, _, _ = state
        if len(owners) < 1:
            return False, "Shared workspace ended up with 0 owners!"
        if owners & members:
            return False, "Human is simultaneously owner and non-owner!"
        return True, ""

    return bfs_check(
        "M1",
        "Workspace Ownership & Triggers",
        "Shared workspace always retains >= 1 owner under concurrent removals",
        "safety",
        init,
        lambda s: step_tx(s, 1) + step_tx(s, 2),
        inv,
        [
            "apps/server/src/features/workspaces/service.ts",
            "db/migrations/0007_workspace_owner_guards.sql",
            "db/migrations/0008_workspace_ownership_write_order.sql",
        ],
    )


def check_m2a(facts: dict[str, Any]) -> CheckResult:
    supersedes_failed = facts["m2a_supersedes_failed"]
    init = (None, None, False, False)

    def can_reinvite(status, delivery, expired):
        if status is None or status == "expired":
            return True
        if status == "pending" and expired:
            return True
        if status == "pending" and supersedes_failed and delivery == "failed":
            return True
        return False

    def next_states(state):
        status, delivery, expired, in_flight = state
        out = []
        if can_reinvite(status, delivery, expired):
            out.append(("owner: invite() commits pending row (delivery=null, 7d TTL)", ("pending", None, False, True)))
        if in_flight:
            out.append(("smtp: deliver() succeeds -> recordDelivery('sent')", (status, "sent" if status == "pending" else delivery, expired, False)))
            out.append(("smtp: deliver() fails -> recordDelivery('failed')", (status, "failed" if status == "pending" else delivery, expired, False)))
        if status == "pending" and not expired and delivery != "failed":
            out.append(("recipient: redeemWorkspaceInvitation() -> accepted", ("accepted", delivery, expired, in_flight)))
        return out

    def inv(state):
        status, delivery, expired, in_flight = state
        can_redeem = status == "pending" and not expired and delivery != "failed"
        if status == "pending" and not expired and not in_flight and not can_redeem and not can_reinvite(status, delivery, expired):
            return False, "7-day lockout dead state: failed invitation cannot be redeemed and blocks re-invitation."
        return True, ""

    return bfs_check(
        "M2a",
        "Workspace Invitations",
        "No 7-day lockout after failed SMTP delivery",
        "liveness",
        init,
        next_states,
        inv,
        ["apps/server/src/features/workspaces/service.ts"],
    )


def check_m2b(facts: dict[str, Any]) -> CheckResult:
    guarded = facts["m2b_guarded"]
    init = (None, None, False)

    def next_states(state):
        status, delivery, in_flight = state
        out = []
        if status is None:
            out.append(("invite() commits pending row (delivery=null)", ("pending", None, True)))
        if in_flight:
            new_fail = ("failed" if status == "pending" else delivery) if guarded else "failed"
            new_sent = ("sent" if status == "pending" else delivery) if guarded else "sent"
            out.append(("deliver() throws late error -> recordDelivery('failed')", (status, new_fail, False)))
            out.append(("deliver() succeeds -> recordDelivery('sent')", (status, new_sent, False)))
        if status == "pending" and delivery != "failed":
            out.append(("recipient redeems token -> status='accepted'", ("accepted", delivery, in_flight)))
        return out

    def inv(state):
        status, delivery, _ = state
        if status == "accepted" and delivery == "failed":
            return False, "Accepted invitation overwritten with delivery_status='failed'."
        return True, ""

    return bfs_check(
        "M2b",
        "Invitation Delivery Tracking",
        "Accepted invitation never has delivery_status='failed'",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/workspaces/service.ts",
            "apps/server/src/features/invitations/service.ts",
        ],
    )


def check_m3(facts: dict[str, Any]) -> CheckResult:
    init = (False, "pending_stale_null", None, "idle", "idle", None)

    def next_states(state):
        human, inv_s, lock, admin_pc, reg_pc, action = state
        if action is None:
            return [
                ("model: start with an initial installation invite", (*state[:-1], "inviteInstallation")),
                ("model: start with a resend of an expired invitation", (human, "expired", lock, admin_pc, reg_pc, "resendInstallation")),
            ]
        serialized = facts["m3_serialized" if action == "inviteInstallation" else "m3_resend_serialized"]
        out = []
        if serialized:
            if admin_pc == "idle" and lock is None:
                out.append((f"admin: {action}() acquires per-email lock", (human, inv_s, "admin", "locked", reg_pc)))
            elif admin_pc == "locked":
                if human:
                    out.append(("admin: emailRegistered(tx)=true -> rollback account_exists", (human, inv_s, None, "done_rejected", reg_pc)))
                else:
                    out.append(("admin: emailRegistered(tx)=false -> supersede & insert pending", (human, "pending_fresh", None, "done_ok", reg_pc)))
            if reg_pc == "idle" and lock is None and not human:
                out.append(("recipient: createInvitedHuman() acquires per-email lock", (human, inv_s, "reg", admin_pc, "locked")))
            elif reg_pc == "locked":
                out.append(("recipient: createInvitedHuman() commits human", (True, "accepted", None, admin_pc, "done")))
        else:
            if admin_pc == "idle" and (not human or action == "resendInstallation"):
                out.append((f"admin: {action}() starts without a serialized account check", (human, inv_s, lock, "checked", reg_pc)))
            elif admin_pc == "checked":
                tag = "done_after_human" if human else "done_ok"
                out.append((f"admin: {action}() TX commits pending without rechecking humans", (human, "pending_fresh", lock, tag, reg_pc)))
            if reg_pc == "idle" and not human:
                out.append(("recipient: registers account & commits human", (True, "accepted", lock, admin_pc, "done")))
        return [(label, (*next_state, action)) for label, next_state in out]

    def inv(state):
        _, _, _, admin_pc, _, _ = state
        if admin_pc == "done_after_human":
            return False, "TOCTOU: fresh pending installation invitation committed after account already existed."
        return True, ""

    return bfs_check(
        "M3",
        "Installation Invitations",
        "No fresh pending installation invitation committed after email is registered",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/invitations/service.ts",
            "apps/server/src/features/accounts/service.ts",
        ],
    )


def check_m4(facts: dict[str, Any]) -> CheckResult:
    locked = facts["m4_issue_for_update"] and facts["m4_knowledge_for_update"]
    init = (("T1", "open"), (), None, ("idle",), ("idle",), ("idle",))

    def next_states(state):
        (title, status), activity, lock, tx1, tx2, tx3 = state
        out = []

        if locked:
            if tx1[0] == "idle" and lock is None:
                out.append(("tx1(close): SELECT ... FOR UPDATE", ((title, status), activity, "tx1", ("locked",), tx2, tx3)))
            elif tx1[0] == "locked":
                if status == "closed":
                    out.append(("tx1(close): no-op", ((title, status), activity, None, ("done",), tx2, tx3)))
                else:
                    out.append(("tx1(close): commit closed + issue_closed", ((title, "closed"), activity + ("issue_closed",), None, ("done",), tx2, tx3)))

            if tx2[0] == "idle" and lock is None:
                out.append(("tx2(edit): SELECT ... FOR UPDATE", ((title, status), activity, "tx2", tx1, ("locked",), tx3)))
            elif tx2[0] == "locked":
                out.append(("tx2(edit): commit title=T2 + issue_edited", (("T2", status), activity + ("issue_edited",), None, tx1, ("done",), tx3)))

            if tx3[0] == "idle" and lock is None:
                out.append(("tx3(close2): SELECT ... FOR UPDATE", ((title, status), activity, "tx3", tx1, tx2, ("locked",))))
            elif tx3[0] == "locked":
                if status == "closed":
                    out.append(("tx3(close2): no-op", ((title, status), activity, None, tx1, tx2, ("done",))))
                else:
                    out.append(("tx3(close2): commit closed + issue_closed", ((title, "closed"), activity + ("issue_closed",), None, tx1, tx2, ("done",))))
        else:
            if tx1[0] == "idle":
                out.append((f"tx1(close): requireIssue() reads ({title}, {status}) [NO FOR UPDATE]", ((title, status), activity, lock, ("read", title, status), tx2, tx3)))
            elif tx1[0] == "read":
                _, st, ss = tx1
                if ss == "closed":
                    out.append(("tx1(close): no-op", ((title, status), activity, lock, ("done",), tx2, tx3)))
                else:
                    out.append((f"tx1(close): UPDATE ({st}, closed) + issue_closed", ((st, "closed"), activity + ("issue_closed",), lock, ("done",), tx2, tx3)))

            if tx2[0] == "idle":
                out.append((f"tx2(edit): requireIssue() reads ({title}, {status}) [NO FOR UPDATE]", ((title, status), activity, lock, tx1, ("read", title, status), tx3)))
            elif tx2[0] == "read":
                _, _, ss = tx2
                out.append((f"tx2(edit): UPDATE (T2, {ss}) + issue_edited", (("T2", ss), activity + ("issue_edited",), lock, tx1, ("done",), tx3)))

            if tx3[0] == "idle":
                out.append((f"tx3(close2): requireIssue() reads ({title}, {status}) [NO FOR UPDATE]", ((title, status), activity, lock, tx1, tx2, ("read", title, status))))
            elif tx3[0] == "read":
                _, st, ss = tx3
                if ss == "closed":
                    out.append(("tx3(close2): no-op", ((title, status), activity, lock, tx1, tx2, ("done",))))
                else:
                    out.append((f"tx3(close2): UPDATE ({st}, closed) + issue_closed", ((st, "closed"), activity + ("issue_closed",), lock, tx1, tx2, ("done",))))
        return out

    def inv(state):
        (title, status), activity, _, tx1, tx2, tx3 = state
        if activity.count("issue_closed") > 1:
            return False, f"Duplicate issue_closed events under concurrency: {list(activity)}"
        if tx1[0] == "done" and tx2[0] == "done" and tx3[0] == "done":
            if title != "T2" or status != "closed":
                return False, f"Lost update: DB has (title={title}, status={status}), activity={list(activity)}"
        return True, ""

    return bfs_check(
        "M4",
        "Project Issues & Knowledge",
        "Concurrent PATCHes preserve edits, match activity log, and emit <= 1 issue_closed",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/projects/service.ts"],
    )


def check_m5(facts: dict[str, Any]) -> CheckResult:
    safe = facts["m5_safe_rotation"]
    init = (frozenset(), "idle", "idle", frozenset())

    def next_states(state):
        live, c1, c2, ok = state
        out = []
        if safe:
            if c1 == "idle":
                out.append(("call1: insert tok1", (live | {"tok1"}, "sending", c2, ok)))
            elif c1 == "sending":
                nl = frozenset({"tok1"}) if "tok1" in live else live
                out.append(("call1: sendMail ok -> retire older if tok1 present -> 200", (nl, "done", c2, ok | {"tok1"})))
                out.append(("call1: sendMail fails -> delete tok1 only", (live - {"tok1"}, "done", c2, ok)))
            if c2 == "idle":
                out.append(("call2: insert tok2", (live | {"tok2"}, c1, "sending", ok)))
            elif c2 == "sending":
                nl = frozenset({"tok2"}) if "tok2" in live else live
                out.append(("call2: sendMail ok -> retire older if tok2 present -> 200", (nl, c1, "done", ok | {"tok2"})))
                out.append(("call2: sendMail fails -> delete tok2 only", (live - {"tok2"}, c1, "done", ok)))
        else:
            if c1 == "idle":
                out.append(("call1: delete all unused & insert tok1", (frozenset({"tok1"}), "sending", c2, ok)))
            elif c1 == "sending":
                out.append(("call1: sendMail ok -> 200", (live, "done", c2, ok | {"tok1"})))
                out.append(("call1: sendMail fails -> delete tok1", (live - {"tok1"}, "done", c2, ok)))
            if c2 == "idle":
                out.append(("call2: delete all unused & insert tok2", (frozenset({"tok2"}), c1, "sending", ok)))
            elif c2 == "sending":
                out.append(("call2: sendMail ok -> 200", (live, c1, "done", ok | {"tok2"})))
                out.append(("call2: sendMail fails -> delete tok2", (live - {"tok2"}, c1, "done", ok)))
        return out

    def inv(state):
        live, c1, c2, ok = state
        if c1 == "done" and c2 == "done" and ok:
            if not (live & ok):
                return False, f"All 200-OK verification tokens dead: live={sorted(live)}, ok={sorted(ok)}"
        return True, ""

    return bfs_check(
        "M5",
        "Email Verification Tokens",
        "Settled 200-OK sendTestEmail leaves a live redeemable verification token",
        "liveness",
        init,
        next_states,
        inv,
        ["apps/server/src/features/settings/service.ts"],
    )


def check_m6(facts: dict[str, Any]) -> CheckResult:
    singleton = facts["m6_singleton_tx"]
    init = (False, 0, 0, "idle", "idle")

    def next_states(state):
        done, admins, pws, t1, t2 = state
        out = []
        for idx, t in ((1, t1), (2, t2)):
            if t == "idle":
                if not done or not singleton:
                    out.append((
                        f"setup{idx}: commit admin + personal workspace + instance_setup",
                        (True, admins + 1, pws + 1, "ok" if idx == 1 else t1, "ok" if idx == 2 else t2),
                    ))
                else:
                    out.append((
                        f"setup{idx}: rollback setup_complete (409)",
                        (done, admins, pws, "409" if idx == 1 else t1, "409" if idx == 2 else t2),
                    ))
        return out

    def inv(state):
        done, admins, pws, _, _ = state
        if admins > 1 or (done and (admins != 1 or pws != 1)):
            return False, f"Bootstrap singleton violated: admins={admins}, personal_ws={pws}"
        return True, ""

    return bfs_check(
        "M6",
        "Bootstrap Singleton",
        "Exactly one administrator and personal workspace created across concurrent setups",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/accounts/service.ts"],
    )


def check_m7(facts: dict[str, Any]) -> CheckResult:
    # A non-member probes every endpoint that decides anything in a shared workspace,
    # once against an existing id and once against a missing id. The shared helper and
    # requireOwner apply to all of them, but each endpoint's own actor lookup is checked
    # separately so a correct guard in a neighbouring path cannot hide a leak here.
    endpoints: list[tuple[str, bool]] = [
        ("GET /api/workspaces/:id", facts["m7_get_404"]),
        *[(path, facts["m7_endpoint_reads"][path]) for path in sorted(facts["m7_endpoint_reads"])],
    ]
    helper_ok = (
        facts["m7_read_membership_404"]
        and facts["m7_require_owner_404"]
        and facts["m7_require_inviter_404"]
    )
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for path, lookup_ok in endpoints:
            existing = 404 if helper_ok and lookup_ok else 403
            out.append((f"non-member {path}", ("probed", path, existing, 404)))
        return out

    def inv(state):
        if state[0] == "probed" and state[2] != state[3]:
            return False, f"Enumeration oracle on {state[1]}: existing={state[2]} vs missing={state[3]}"
        return True, ""

    return bfs_check(
        "M7",
        "Workspace Access Boundary",
        "Non-members receive 404 workspace_not_found on every shared-workspace endpoint (never 403)",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/workspaces/service.ts"],
    )


def check_m8(facts: dict[str, Any]) -> CheckResult:
    # Models setProjectAccess() racing with removeMember() on a shared workspace member.
    serialized = facts["m8_access_serialized"]
    # State: (is_member, has_grant, lock, grant_pc, remove_pc)
    init = (True, False, None, "idle", "idle")

    def next_states(state):
        is_member, has_grant, lock, g_pc, r_pc = state
        out = []
        if serialized:
            if g_pc == "idle" and lock is None:
                out.append(("setProjectAccess: acquire lock_workspace_ownership_writes()", (is_member, has_grant, "grant", "locked", r_pc)))
            elif g_pc == "locked":
                if is_member:
                    out.append(("setProjectAccess: commit grant", (is_member, True, None, "done", r_pc)))
                else:
                    out.append(("setProjectAccess: reject member_not_found", (is_member, has_grant, None, "done", r_pc)))
            if r_pc == "idle" and lock is None:
                out.append(("removeMember: acquire lock_workspace_ownership_writes()", (is_member, has_grant, "remove", g_pc, "locked")))
            elif r_pc == "locked":
                out.append(("removeMember: delete membership + revoke grants + commit", (False, False, None, g_pc, "done")))
        else:
            if g_pc == "idle" and is_member:
                out.append(("setProjectAccess: trigger sees member & inserts grant (uncommitted)", (is_member, has_grant, lock, "inserted", r_pc)))
            elif g_pc == "inserted":
                out.append(("setProjectAccess: commits grant", (is_member, True, lock, "done", r_pc)))
            if r_pc == "idle" and is_member:
                out.append(("removeMember: deletes membership & sees 0 committed grants", (False, False, lock, g_pc, "done")))
        return out

    def inv(state):
        is_member, has_grant, _, g_pc, r_pc = state
        if g_pc == "done" and r_pc == "done" and not is_member and has_grant:
            return False, "Orphaned project_access_grants row survived removeMember() and will revive on rejoin!"
        return True, ""

    return bfs_check(
        "M8",
        "Project Access Grants (#27)",
        "No orphaned project_access_grants row survives concurrent removeMember()",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/workspaces/service.ts",
            "db/migrations/0012_project_access_scope.sql",
        ],
    )


def check_m9(facts: dict[str, Any]) -> CheckResult:
    # The offer is a project in the invited workspace. It can be moved to another
    # workspace after the invitation is created, and it can be resent before acceptance.
    # The model assumes atomic commits and rollback. It checks scope and preservation
    # under that assumption, not whether the database actually rolls back every write.
    offer_persisted = facts["m9_offer_persisted"]
    existing_checked = facts["m9_existing_applies"] and facts["m9_apply_validates"]
    registration_checked = facts["m9_registration_applies"] and facts["m9_apply_validates"]
    resend_validates = facts["m9_resend_validates"]
    preview_validates = facts["m9_preview_validates"]
    resend_copies = facts["m9_resend_copies"]
    initial = ("invited", offer_persisted, "pending", False, False, False)

    def next_states(state):
        project_workspace, offer_present, token, membership, grant, resent = state
        out = []
        if project_workspace == "invited" and token == "pending":
            out.append(
                (
                    "project transfer: project.workspace_id changes after the offer",
                    ("other", offer_present, token, membership, grant, resent),
                )
            )
        scope_valid = not offer_present or project_workspace == "invited"
        # A dead offer must not lock the address for seven days even when its inviter is
        # still an owner. A fresh invite supersedes it only if the liveness check also
        # verifies the offered scope, not just the inviter's role and mailbox.
        if token == "pending" and offer_present and not scope_valid:
            if facts["m9_owner_stale_supersedes"]:
                out.append(
                    (
                        "invite: a fresh offer supersedes the owner's stale-scope offer",
                        ("invited", True, "superseded", membership, grant, resent),
                    )
                )
            else:
                out.append(
                    (
                        "invite: the owner's stale-scope offer blocks the address (invitation_pending)",
                        (project_workspace, offer_present, "blocked", membership, grant, resent),
                    )
                )
        if token == "pending" and not membership:
            out.append(("recipient: joins via a newer offer after the original expires", (project_workspace, offer_present, "expired", True, grant, resent)))
        if token in ("pending", "expired") and not resent:
            if membership:
                if not facts["m9_resend_rejects_member"]:
                    out.append(("resendInvitation: mails an existing member", (project_workspace, offer_present, "member_resend", membership, grant, True)))
            elif not scope_valid and not resend_validates:
                out.append(("resendInvitation: rotates a stale offer", (project_workspace, offer_present, "stale_resend", membership, grant, True)))
            elif scope_valid and offer_present and not resend_copies:
                out.append(
                    (
                        "resendInvitation: replacement loses the offered project",
                        (project_workspace, False, token, membership, grant, True),
                    )
                )
            elif scope_valid:
                out.append(
                    (
                        "resendInvitation: replacement copies the offered project",
                        (project_workspace, offer_present, token, membership, grant, True),
                    )
                )
        if token == "pending":
            if not scope_valid and not preview_validates:
                out.append(("previewInvitation: exposes a stale offer", (project_workspace, offer_present, "stale_preview", membership, grant, resent)))
            for path, checked, applies in (
                ("acceptInvitation", existing_checked, facts["m9_existing_applies"]),
                ("registerThroughInvitation", registration_checked, facts["m9_registration_applies"]),
            ):
                if offer_present and project_workspace != "invited" and checked:
                    # The common redemption path rejects before committing, so the
                    # token and every row stay as they were.
                    continue
                grant_written = offer_present and applies and facts["m9_grant_writer"]
                out.append(
                    (
                        f"{path}: commit acceptance",
                        (project_workspace, offer_present, "accepted", True, grant_written, resent),
                    )
                )
        return out

    def inv(state):
        project_workspace, offer_present, token, membership, grant, resent = state
        if not offer_persisted:
            return False, "Invitation creation does not persist any offered project grant!"
        if token == "member_resend":
            return False, "An existing workspace member was sent a replacement invitation!"
        if token == "blocked":
            return False, "A dead owner invitation blocked a fresh offer for seven days!"
        if token in ("stale_resend", "stale_preview"):
            return False, "An invitation with stale project scope was exposed or rotated!"
        if grant and project_workspace != "invited":
            return False, "A project grant was applied after its project left the invited workspace!"
        if token == "accepted" and offer_present and not grant:
            return False, "Acceptance omitted an offered project grant!"
        if resent and not offer_present:
            return False, "Resend lost the offered project grant!"
        return True, ""

    return bfs_check(
        "M9",
        "Workspace Invitation Project Grants (#25)",
        "Valid project scope survives resend; stale scope and existing members cannot receive replacements",
        "safety",
        initial,
        next_states,
        inv,
        [
            "apps/server/src/features/workspaces/service.ts",
            "apps/server/src/features/projects/service.ts",
        ],
    )


def check_m10(facts: dict[str, Any]) -> CheckResult:
    # #28 delegation ceilings and inviter authority. Every scenario is a direct attempt
    # against the service's decision points; the BFS depth is one transition because the
    # decisions are independent and each has a single commit/reject outcome. The guard
    # for each attempt is extracted from its own function, so deleting one guard produces
    # a short counterexample naming the exact API path and TS function.
    cap_ceiling = facts["m10_capability_ceiling"]
    project_guard = facts["m10_project_manage_guard"]
    redeems = facts["m10_redeem_checks_inviter"]
    accept_check = redeems and facts["m10_accept_redeems"]
    register_check = redeems and facts["m10_register_redeems"]

    # (API call in the code's own words, forbidden?, guard that prevents the commit)
    attempts: list[tuple[str, bool, bool]] = [
        ("updateMemberCapability(permission manager, other member, {canManageMemberPermissions:true})", True, facts["m10_owner_only_manager"]),
        ("updateMemberCapability(permission manager, other member, {canManageMemberPermissions:false})", True, facts["m10_owner_only_manager"]),
        ("updateMemberCapability(permission manager, owner, {canCreateProjects:true})", True, facts["m10_no_owner_modify"]),
        ("updateMemberCapability(permission manager, themselves, {canCreateProjects:true})", True, facts["m10_no_self_modify"]),
        ("updateMemberCapability(permission manager without Invite members, other member, {canInviteMembers:true})", True, cap_ceiling),
        ("updateMemberCapability(permission manager without Remove members, other member, {canRemoveMembers:false})", True, cap_ceiling),
        ("removeMember(member with Remove members, owner)", True, facts["m10_remove_protected"]),
        ("removeMember(member with Remove members, permission manager)", True, facts["m10_remove_protected"]),
        ("removeMember(ordinary member without Remove members, other member)", True, facts["m10_remove_authority"]),
        ("invite(delegated inviter without Manage, projectGrants:[unmanaged project])", True, facts["m10_invite_scope"] and project_guard),
        ("resendInvitation(delegated inviter, offer with an unmanaged project)", True, facts["m10_resend_scope"] and project_guard),
        ("revokeInvitation(delegated inviter, another inviter's offer with an unmanaged project)", True, facts["m10_revoke_scope"] and project_guard),
        ("invitations(delegated inviter, history includes an offer on an unmanaged project)", True, facts["m10_list_scoping"]),
        ("invite(delegated inviter, a dead pending offer from an unauthorized inviter blocks the address)", True, facts["m10_dead_offer_supersedes"]),
        ("acceptInvitation(inviter lost canInviteMembers)", True, accept_check and facts["m10_redemption_capability"]),
        ("registerThroughInvitation(inviter lost canInviteMembers)", True, register_check and facts["m10_redemption_capability"]),
        ("acceptInvitation(inviter lost Manage on the offered project)", True, accept_check and facts["m10_redemption_project_scope"] and project_guard),
        ("registerThroughInvitation(inviter lost Manage on the offered project)", True, register_check and facts["m10_redemption_project_scope"] and project_guard),
        ("acceptInvitation(inviter left the workspace)", True, accept_check and facts["m10_redemption_membership"]),
        ("registerThroughInvitation(inviter left the workspace)", True, register_check and facts["m10_redemption_membership"]),
        ("acceptInvitation(inviter's email is no longer verified)", True, accept_check and facts["m10_redemption_verified"]),
        ("registerThroughInvitation(inviter's email is no longer verified)", True, register_check and facts["m10_redemption_verified"]),
        # Positive controls: the ceilings must not turn legitimate delegation into a no-op.
        ("updateMemberCapability(owner, non-owner, all four capabilities)", False, True),
        ("updateMemberCapability(permission manager holding Create projects, other member, {canCreateProjects:true})", False, True),
        ("removeMember(member with Remove members, ordinary member)", False, True),
        ("invite(delegated inviter with Manage, projectGrants:[managed project])", False, True),
        ("invite(delegated inviter, projectGrants:[])", False, True),
        ("revokeInvitation(original inviter revokes their own offer after losing Manage)", False, facts["m10_self_revoke"]),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for idx, (label, forbidden, guard) in enumerate(attempts):
            # Forbidden attempts must be rejected; allowed attempts must commit. Both
            # directions are sensitive to the extracted guard.
            result = "rejected" if guard == forbidden else "committed"
            out.append((f"{label} -> {result}", ("probed", idx, result)))
        return out

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, forbidden, _ = attempts[state[1]]
        expected = "rejected" if forbidden else "committed"
        if state[2] != expected:
            return False, f"{label} {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M10",
        "Workspace Permission Delegation & Inviter Authority (#28)",
        "Only owners appoint permission managers, delegates stay within their own authority, and withdrawn inviter authority cannot be redeemed",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/workspaces/service.ts"],
    )


def check_m11(facts: dict[str, Any]) -> CheckResult:
    # #30 agent-key stateful invariants. Every attempt is a direct call against one of
    # the service's decision points; each guard is extracted from that decision's own
    # function. BFS depth is one because the decisions are independent and each has a
    # single commit/refuse outcome, exactly like M10.
    never = facts["m11_never_skips_expiry_only"]
    ceiling = facts["m11_ceiling"]
    isolation = facts["m11_owner_isolation"]
    audit = facts["m11_events"] and facts["m11_events_without_secret"]

    # (API call in the code's own words, expected outcome, guard that produces it,
    #  outcome when the guard is missing)
    attempts: list[tuple[str, str, bool, str]] = [
        ("GET /api/agents/me with a live key in its own workspace", "authenticated", True, "rejected"),
        ("GET /api/agents/me one second before the deadline", "authenticated", facts["m11_expiry"], "rejected"),
        ("GET /api/agents/me with a Never key whose owner still has access", "authenticated", never and ceiling, "rejected"),
        ("GET /api/agents/me?workspaceId=<another workspace>", "rejected", facts["m11_scope"], "authenticated"),
        ("GET /api/agents/me?projectId=<a project outside the key>", "rejected", facts["m11_project_scope"], "authenticated"),
        ("GET /api/agents/me with a revoked key (including Never)", "rejected", facts["m11_revocation"] and never, "authenticated"),
        ("GET /api/agents/me with a 7-day key just after expiry", "rejected", facts["m11_expiry"], "authenticated"),
        ("GET /api/agents/me after the human owner left the key's workspace (Never)", "rejected", facts["m11_membership"] and never, "authenticated"),
        ("GET /api/agents/me?projectId=... after the human's level was lowered", "effective=contribute", ceiling, "effective=manage"),
        ("GET /api/agents/me?projectId=... after the human's grant was removed", "rejected", ceiling, "effective=manage"),
        ("POST /api/agents/keys with a level above the human's current access", "rejected", facts["m11_issue_ceiling"], "committed"),
        ("POST /api/agents/keys persists only the hash, never the secret", "hash_only", facts["m11_key_hash_only"], "secret_stored"),
        ("DELETE /api/workspaces/A/agent-keys/<key in A> (owner revokes another human's key)", "revoked", isolation, "rejected"),
        ("DELETE /api/workspaces/A/agent-keys/<key in B> (owner reaches across workspaces)", "rejected", isolation, "revoked"),
        ("repeating a revocation writes no second event", "events=1_no_duplicate", facts["m11_single_event"], "events=2_duplicate"),
        ("the owner's revocation in A leaves a key in B live", "live", isolation, "revoked"),
        ("creation and revocation each write one event, without a secret", "events=2_no_secret", audit, "events=0"),
        ("removeMember revokes the member's workspace keys, so rejoin cannot revive them", "revoked_on_removal", facts["m11_member_removal_revokes_keys"], "live_after_rejoin"),
        ("POST /api/agents/keys racing removeMember leaves no unrevoked key for a removed member", "no_live_key", facts["m11_issue_serialized"], "live_key_for_removed_member"),
        ("GET /api/agents/me reads membership, revocation, and ceilings in one REPEATABLE READ snapshot", "consistent", facts["m11_repeatable_read_auth"], "torn_read"),
        ("direct insert of agent_api_key_projects for a project in another workspace", "rejected", facts["m11_key_project_scope_db"], "committed"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for idx, (label, expected, guard, wrong) in enumerate(attempts):
            result = expected if guard else wrong
            out.append((f"{label} -> {result}", ("probed", idx, result)))
        return out

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M11",
        "Workspace-Scoped Agent API Keys (#30)",
        "Keys are scoped and revocable in one workspace, never outlive their human's access, and audit events carry no secrets",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/agents/service.ts",
            "apps/server/src/features/agents/index.ts",
            "apps/server/src/features/index.ts",
            "apps/server/src/features/workspaces/service.ts",
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0016_clumsy_masked_marvel.sql",
            "db/migrations/0018_agent_key_project_scope.sql",
        ],
    )


def check_m12(facts: dict[str, Any]) -> CheckResult:
    # #33: the same service gate decides REST and MCP; an agent key authenticates on
    # every tool call, so revocation/expiry/demotion apply immediately. Writes name the
    # agent, and neither transport exposes membership or installation administration.
    gate = facts["m12_shared_gate"]
    scope = facts["m12_agent_scope"]
    reauth = facts["m12_mcp_reauth"]
    audit = facts["m12_agent_actor"] and facts["m12_actor_constraint"]

    attempts: list[tuple[str, str, bool, str]] = [
        ("MCP create_issue with a Contribute key", "committed", gate and facts["m12_tools_exist"], "refused"),
        ("MCP edit title/body, close, and reopen with a Contribute key", "committed", gate, "refused"),
        ("MCP create_comment with a Contribute key", "committed", gate, "refused"),
        ("MCP create/update_knowledge with a Contribute key", "committed", gate, "refused"),
        ("REST work routes accept the same bearer key", "same_work_actor", gate and facts["m12_rest_bearer"], "not_signed_in"),
        ("MCP list/get issue and knowledge with a Read key", "inspected", gate, "refused"),
        ("MCP create_issue with a Read key", "refused", gate, "committed"),
        ("MCP update_issue/close with a Read key", "refused", gate, "committed"),
        ("MCP create_comment with a Read key", "refused", gate, "committed"),
        ("MCP create/update_knowledge with a Read key", "refused", gate, "committed"),
        ("REST mutation with a Read key", "refused", gate and facts["m12_rest_bearer"], "committed"),
        ("REST and MCP Read denials share one stable code", "insufficient_project_access", gate, "divergent"),
        ("MCP write on a project in another workspace", "refused", scope, "committed"),
        ("MCP write on a project outside the key grants", "refused", scope, "committed"),
        ("MCP list_projects targeting another workspace the owner belongs to", "refused", facts["m12_list_scope"], "empty_list"),
        ("REST list projects in another workspace the owner belongs to", "refused", facts["m12_list_scope"] and facts["m12_rest_bearer"], "empty_list"),
        ("MCP call with a key revoked after the client connected", "refused", reauth, "committed"),
        ("REST call with a revoked key", "refused", reauth and facts["m12_rest_bearer"], "committed"),
        ("MCP call with a key whose human grant was lowered", "refused", reauth and gate, "committed"),
        ("MCP write records the agent as actor, never its human owner", "actor=agent", audit, "actor=human"),
        ("stored issue/activity row has exactly one actor identity", "one_actor", facts["m12_actor_constraint"], "two_actors"),
        ("MCP tool list offers membership, invitation, or installation administration", "refused", facts["m12_no_admin_tools"], "exposed"),
        ("bearer key accepted on a REST project-admin or workspace/settings route", "refused", facts["m12_rest_admin_session"], "accepted"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M12",
        "Agent Project Work Through MCP (#33)",
        "One gate decides REST and MCP project work, agents are the recorded actors, a key is scoped to one workspace, and no key reaches membership or administration",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/projects/rest.ts",
            "apps/server/src/features/projects/mcp.ts",
            "apps/server/src/features/agents/auth.ts",
            "packages/contract/src/mcp-tools.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0017_rapid_talon.sql",
        ],
    )


def check_m13(facts: dict[str, Any]) -> CheckResult:
    # #32 history visibility. Every attempted read is a direct request against one of the
    # three history routes; each guard is extracted from the decision that enforces it.
    # The 4th tuple item is the outcome when the guard is missing: if a source guard is
    # removed, that attempt resolves to the wrong outcome and this check FAILS. That is
    # the sensitivity proof — positive controls below also fail if a guard over-blocks.
    attempts: list[tuple[str, str, bool, str]] = [
        # Positive controls: the entitled reader really does get the events.
        ("workspace owner reads membership, key, and project access history", "visible", facts["m13_owner_keys"], "omitted"),
        ("delegated permission manager reads workspace membership history", "visible", facts["m13_delegate_scope"], "403"),
        ("project reader sees attributed activity in a granted project", "activity", facts["m13_activity_granted"], "404"),
        ("project manager additionally sees access events in their project", "access+activity", facts["m13_manage_access"], "activity_only"),
        ("system administrator reads installation history", "visible", facts["m13_admin_only"], "403"),
        ("all three history routes use the human session reader", "session", facts["m13_session_only"], "bearer"),
        # Scope isolation: out-of-scope workspaces and projects are indistinguishable
        # from missing ones, and a delegate's project view stops at what they Manage.
        ("non-member reads another workspace's history", "404", facts["m13_workspace_404"], "200"),
        ("system administrator reads a workspace they do not belong to", "404", facts["m13_workspace_404"], "200"),
        ("ordinary member reads workspace access history", "403", facts["m13_delegate_scope"], "200"),
        ("delegated manager reads another workspace's history", "404", facts["m13_workspace_404"], "200"),
        ("delegated manager reads access events for a project they do not Manage", "omitted", facts["m13_delegate_scope"], "included"),
        ("ordinary member reads an ungranted project's history", "404", facts["m13_project_404"], "200"),
        ("system administrator reads a private project's history", "404", facts["m13_project_404"], "200"),
        ("ordinary member sees project access events in a granted project", "omitted", facts["m13_manage_access"], "included"),
        ("delegated manager reads a key event from their workspace", "omitted", facts["m13_owner_keys"], "included"),
        # Installation history carries only installation records; no private content.
        ("ordinary account reads installation history", "403", facts["m13_admin_only"], "200"),
        ("installation history includes another workspace's membership events", "absent", facts["m13_installation_scope"], "included"),
        ("installation history includes a private project's activity", "absent", facts["m13_installation_scope"], "included"),
        # Secrets never enter an event payload or a history response.
        ("history response carries a credential secret", "absent", facts["m13_no_secret"], "included"),
        ("credential event carries a token hash", "absent", facts["m13_no_secret"], "included"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M13",
        "History Visibility Boundaries (#32)",
        "Owners and delegates see in-scope access history, members only granted-project activity, administrators only installation events, out-of-scope reads are 404, and no secret is returned",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/history/service.ts",
            "apps/server/src/features/history/rest.ts",
            "packages/contract/src/history.ts",
            "apps/server/src/features/accounts/index.ts",
            "apps/server/src/features/projects/index.ts",
            "apps/server/src/db/schema.ts",
        ],
    )


def check_m15(facts: dict[str, Any]) -> CheckResult:
    # #31 password recovery and local administrator recovery. BFS over the token
    # lifecycle (issued, just before/after expiry in database time, used), delivery
    # failures, and both password-change paths. Every guard comes from the source of
    # the decision; removing one makes the corresponding forbidden state reachable.
    single_use = facts["m15_single_use"]
    db_time = facts["m15_db_time_expiry"]
    unverified_guard = facts["m15_unverified_no_mail"]
    uniform = facts["m15_uniform_response"]
    failed_send_deletes = facts["m15_failed_send_deletes_token"]
    one_tx = facts["m15_one_tx"]
    sessions_cleared = facts["m15_sessions_cleared"]
    keys_untouched = facts["m15_agent_keys_untouched"]
    scope_untouched = facts["m15_scope_untouched"]
    audit_ok = facts["m15_events_without_secret"]
    local_no_smtp = facts["m15_local_no_smtp"]
    revoke_pending = facts["m15_revokes_pending_tokens"]
    admin_only = facts["m15_admin_only_local"]

    fields = [
        "token", "verified", "smtp", "mailed", "pw_changed", "expired_used", "reused",
        "torn", "leak", "secret_event", "bootstrap", "owner", "sessions", "keys",
        "events", "smtp_dependency", "unverified_mailed", "raw_token_stored", "no_problem",
        "other_token", "non_admin_local",
    ]
    idx = {name: i for i, name in enumerate(fields)}

    def setf(state, **kwargs):
        values = list(state)
        for name, value in kwargs.items():
            values[idx[name]] = value
        return tuple(values)

    def add_event(events, kind):
        # A frozenset keeps the event space finite across repeated requests; only the
        # presence of a secret-free event matters to this model.
        return events | {kind}

    init = (
        "none", False, True, False, False, False, False, False, False, False,
        "closed", "u1", frozenset({"s1", "s2"}), frozenset({"k1"}), frozenset(),
        False, False, not facts["m15_token_hash_only"], not facts["m15_http_problems"],
        "none", False,
    )

    def next_states(state):
        out = []
        token = state[idx["token"]]

        # Environment: the separate verification flow and the administrator's relay.
        if not state[idx["verified"]]:
            out.append(("email verified by the separate verification flow", setf(state, verified=True)))
        if state[idx["smtp"]]:
            out.append(("SMTP breaks", setf(state, smtp=False)))
        else:
            out.append(("SMTP repaired", setf(state, smtp=True)))

        # Every request answers the same resource; only an eligible, verified address
        # with a working relay creates a live token and sends mail.
        for label, eligibility in (
            ("request for an unknown address", "unknown"),
            ("request for an unverified address", "unverified"),
            ("request for a verified address", "verified"),
        ):
            new = state
            if not uniform:
                new = setf(new, leak=True)
            if eligibility == "verified" and state[idx["smtp"]]:
                new = setf(
                    new,
                    token="pre",
                    mailed=True,
                    events=add_event(state[idx["events"]], "requested"),
                )
                if state[idx["pw_changed"]]:
                    # A fresh request after a password change is legitimate, not a
                    # leftover link that survived the change.
                    new = setf(new, other_token="none")
                elif token in ("pre", "post"):
                    # A second request while another link is live: two outstanding
                    # links, only one of which the confirm POST will consume.
                    new = setf(new, other_token="live")
                if not audit_ok:
                    new = setf(new, secret_event=True)
            elif eligibility == "verified" and not failed_send_deletes:
                # Mail never left, but a token row survived: an undelivered link is live.
                new = setf(new, token="pre", mailed=False)
            elif eligibility == "unverified" and not unverified_guard:
                new = setf(
                    new,
                    token="pre",
                    mailed=True,
                    unverified_mailed=True,
                    events=add_event(state[idx["events"]], "requested"),
                )
                if not audit_ok:
                    new = setf(new, secret_event=True)
            out.append((label, new))

        # The token crosses its one-hour deadline in database time.
        if token == "pre":
            out.append(("database time passes the one-hour deadline", setf(state, token="post")))

        # Redemption: a POST is the only thing that consumes the token.
        if token in ("pre", "post", "used"):
            # A fresh token redeems either way; single-use and database-time expiry are
            # what refuse the *later* attempts (reuse and post-deadline redemption).
            allowed = (
                token == "pre"
                or (token == "post" and not db_time)
                or (token == "used" and not single_use)
            )
            if allowed:
                new = setf(
                    state,
                    token="used",
                    sessions=frozenset(),
                    events=add_event(state[idx["events"]], "completed"),
                )
                if token == "post":
                    new = setf(new, expired_used=True)
                if token == "used":
                    new = setf(new, reused=True)
                if not one_tx:
                    # Token consumed but the password change did not commit with it.
                    new = setf(new, torn=True)
                else:
                    new = setf(new, pw_changed=True)
                if not sessions_cleared:
                    new = setf(new, sessions=state[idx["sessions"]])
                if not keys_untouched:
                    new = setf(new, keys=frozenset())
                if not audit_ok:
                    new = setf(new, secret_event=True)
                if revoke_pending:
                    new = setf(new, other_token="none")
                out.append(("confirmReset(token) redeems the link", new))
            else:
                out.append(("confirmReset(token) refused: invalid, expired, or used", state))
        else:
            out.append(("confirmReset(fabricated token) refused", state))

        # The local command changes the password with no email, no token, and no SMTP.
        new = setf(
            state,
            sessions=frozenset(),
            pw_changed=True,
            events=add_event(state[idx["events"]], "local"),
        )
        if not sessions_cleared:
            new = setf(new, sessions=state[idx["sessions"]])
        if not keys_untouched:
            new = setf(new, keys=frozenset())
        if not scope_untouched:
            new = setf(new, bootstrap="open", owner="u2")
        if not audit_ok:
            new = setf(new, secret_event=True)
        if not local_no_smtp:
            new = setf(new, smtp_dependency=True)
        if revoke_pending:
            new = setf(new, other_token="none")
        out.append(("local recovery changes the password with broken SMTP", new))

        # Local recovery is an administrator-only path. An ordinary human with local
        # shell access must be refused, not handed a public recovery bypass.
        if not admin_only:
            out.append(
                (
                    "local recovery invoked for an ordinary account [NOT ADMIN]",
                    setf(new, non_admin_local=True),
                )
            )
        else:
            out.append(("local recovery refused for an ordinary account", state))
        return out

    def inv(state):
        if state[idx["leak"]]:
            return False, "A recovery response revealed whether an account exists or is verified."
        if state[idx["unverified_mailed"]]:
            return False, "A password reset was mailed to an unverified address."
        if state[idx["raw_token_stored"]]:
            return False, "A raw reset token, password, or secret was stored."
        if state[idx["no_problem"]]:
            return False, "A validated recovery route does not declare a 400 Problem."
        if state[idx["secret_event"]]:
            return False, "A recovery event carried a secret, or its table can store one."
        if state[idx["expired_used"]]:
            return False, "A reset token just after its database-time deadline was redeemed."
        if state[idx["reused"]]:
            return False, "A single-use reset token was redeemed twice."
        if state[idx["torn"]]:
            return False, "A token was consumed without the password change committing with it."
        if state[idx["token"]] == "used" and not state[idx["mailed"]]:
            return False, "A token whose email never left was redeemable."
        if state[idx["pw_changed"]] and state[idx["sessions"]]:
            return False, "Prior browser sessions survived a password change."
        if state[idx["pw_changed"]] and state[idx["keys"]] != frozenset({"k1"}):
            return False, "Agent API keys were touched by a password recovery."
        if state[idx["pw_changed"]] and state[idx["other_token"]] == "live":
            return False, "An earlier unused reset link survived a password change."
        if state[idx["non_admin_local"]]:
            return False, "Local recovery was used by a non-administrator."
        if state[idx["bootstrap"]] != "closed":
            return False, "Local recovery reopened bootstrap."
        if state[idx["owner"]] != "u1":
            return False, "Local recovery changed workspace ownership."
        if state[idx["smtp_dependency"]]:
            return False, "Local recovery depended on a working SMTP relay."
        return True, ""

    return bfs_check(
        "M15",
        "Password Recovery & Local Recovery (#31)",
        "Reset links are single-use, expire in database time, and are all retired on a password change; unverified addresses are never mailed, responses never enumerate accounts, both paths end browser sessions without touching agent keys/bootstrap/ownership, and local recovery is administrator-only and works without SMTP",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/recovery/service.ts",
            "apps/server/src/features/recovery/rest.ts",
            "apps/server/src/features/accounts/service.ts",
            "apps/server/src/recovery-cli.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0020_flippant_iceman.sql",
        ],
    )


def check_m16(facts: dict[str, Any]) -> CheckResult:
    # #35 rotation. Bounded attempts over the replacement's lifecycle: every attempt is
    # a direct probe of one extracted guard, with the outcome when that guard is missing.
    # Overlap, independent expiry, old-revoke isolation, password-reset independence, and
    # the secret-free replacement event are each named in the code's own API/TS words.
    overlap = facts["m16_same_agent_workspace"] and facts["m16_independent_secret"]
    attempts: list[tuple[str, str, bool, str]] = [
        (
            "POST /api/agents/keys/<live key>/rotate creates a replacement for the same agent and workspace",
            "same_target",
            overlap and facts["m16_serialized"],
            "other_target",
        ),
        (
            "POST rotate mints a new secret and never repeats the source secret",
            "new_secret_only",
            facts["m16_independent_secret"],
            "old_secret_reused",
        ),
        (
            "Both keys authenticate during the overlap",
            "both_live",
            overlap,
            "only_source_live",
        ),
        (
            "DELETE the source key leaves the replacement authenticating",
            "new_live",
            facts["m16_no_cascade"],
            "new_revoked",
        ),
        (
            "DELETE the replacement leaves the source authenticating",
            "old_live",
            facts["m16_no_cascade"],
            "old_revoked",
        ),
        (
            "Letting the source key expire does not expire the replacement",
            "new_live",
            facts["m16_independent_expiry"],
            "new_expired",
        ),
        (
            "Letting the replacement expire does not expire the source",
            "old_live",
            facts["m16_independent_expiry"],
            "old_expired",
        ),
        (
            "The replacement expiry is computed from now, not copied from the source",
            "fresh_expiry",
            facts["m16_independent_expiry"],
            "copied_expiry",
        ),
        (
            "A password reset leaves both the source and replacement keys authenticating",
            "both_live",
            facts["m15_agent_keys_untouched"],
            "keys_swept",
        ),
        ("POST rotate on a revoked key is refused", "refused", facts["m16_revoked_refused"], "rotated"),
        (
            "POST rotate on an expired key is refused in database time",
            "refused",
            facts["m16_expired_refused"],
            "rotated",
        ),
        (
            "POST rotate on another human's key is refused",
            "refused",
            facts["m16_source_ownership"],
            "rotated",
        ),
        (
            "POST rotate on a key whose workspace the human lost is refused",
            "refused",
            facts["m16_workspace_access"],
            "rotated",
        ),
        (
            "POST rotate racing removeMember leaves no unrevoked replacement for a removed member",
            "no_orphan",
            facts["m16_serialized"],
            "orphan_key",
        ),
        (
            "Preserved grants above current human access are capped and explicit grants validated",
            "capped",
            facts["m16_grants_capped"],
            "stale_authority",
        ),
        (
            "Rotation writes one secret-free agent_key_rotated event on the replacement",
            "event_no_secret",
            facts["m16_event"],
            "no_event",
        ),
        (
            "The #32 history view surfaces agent_key_rotated without a secret",
            "surfaced",
            facts["m16_history_surface"],
            "hidden",
        ),
        (
            "The validated rotation route declares a 400 Problem",
            "problem",
            facts["m16_http_problems"],
            "no_problem",
        ),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M16",
        "Agent Key Rotation (#35)",
        "Rotation overlaps the old and new keys with independent expiry and revocation, survives a password reset, caps grants by current access, and records a secret-free event that history surfaces",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/agents/service.ts",
            "apps/server/src/features/agents/rest.ts",
            "apps/server/src/features/history/service.ts",
            "apps/server/src/features/recovery/service.ts",
            "packages/contract/src/agents.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0021_demonic_warstar.sql",
        ],
    )


def check_m14(facts: dict[str, Any]) -> CheckResult:
    # #34: run identity is isolated per agent/workspace/harness/session, a resume reuses
    # the run, children link to their parent, model changes are events, and missing
    # metadata stays unknown. Each attempt is a direct probe of one extracted guard.
    identity = facts["m14_db_identity"] and facts["m14_identity_key"]
    resume = facts["m14_conflict"]
    scope = facts["m14_explicit_scope"]
    child = facts["m14_child_link"]
    child_scope = facts["m14_child_scope"]
    serialized = facts["m14_serialized"]
    history = facts["m14_model_change"]
    unknown = facts["m14_unknown"]
    reported = facts["m14_reported_contract"]
    adapters = facts["m14_adapters"]

    attempts: list[tuple[str, str, bool, str]] = [
        ("two clients share one key but report different native session ids", "2_distinct_runs", identity, "1_shared_run"),
        ("two anonymous children of one run are reported", "2_children", facts["m14_child_link"], "1_collapsed_child"),
        ("two check-ins carry the same (harness, nativeSessionId) under one key", "1_run_resumed", resume and facts["m14_db_identity"], "2_runs"),
        ("a resume reuses an explicit runId of this agent's run", "same_run", scope, "new_run"),
        ("a report names a runId belonging to another workspace's agent", "run_not_found", scope, "run_hijacked"),
        ("child_started reports agentId/agentType on the parent run", "linked_to_parent", child, "unlinked"),
        ("a child runId points at the parent run itself", "run_not_found", child_scope, "self_loop"),
        ("a child runId names a run of another agent", "run_not_found", child_scope, "foreign_agent_link"),
        ("a child runId names a run in another workspace", "run_not_found", child_scope, "cross_workspace_link"),
        ("a repeated child event updates the same child row under a row lock", "1_child_updated", child and serialized, "update_dropped"),
        ("two simultaneous A-to-B model reports share one transaction and row lock", "history=1_no_duplicate", serialized and history, "duplicate_history"),
        ("the model changes from A to B during one run", "history=A_to_B", history, "no_history"),
        ("the same model is reported twice", "no_second_event", history, "duplicate_event"),
        ("a report omits the model", "unknown_or_unchanged", unknown, "model_cleared"),
        ("a report has no runId and no runKey", "runId=null_no_row", unknown, "transport_session_run"),
        ("harness version and model are absent on a new run", "stored_null", unknown, "synthesised"),
        ("a check-in sends reported:{model,harnessVersion} and runKey:null with a runId", "metadata_stored", reported and scope, "metadata_stripped"),
        ("a check-in omits `at` but carries checkIn.at", "observed_at_used", reported, "time_missing"),
        ("a revoked or keyless report is authenticated in the adapters", "refused", adapters, "accepted_by_service"),
        ("REST hook and MCP check-in map key failures to the same codes", "same_codes", adapters, "divergent"),
        ("a human outside the workspace lists its runs", "workspace_not_found", facts["m14_human_scope"], "listed"),
        ("the workspace view names the agent, not only its id", "agentName", facts["m14_human_scope"], "raw_id"),
        ("the run-reporting tool advertises a lease expiry or claim", "absent", facts["m14_no_lease"], "present"),
        ("orrery_run_checkin is registered on MCP", "exposed", facts["m14_tool"], "missing"),
        ("a run is attributed to the authenticated agent, never a reported name", "actor=agent", identity and adapters, "actor=reported"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M14",
        "Runs and Child Workers (#34)",
        "Run identity is isolated per key and harness session, resumes reuse the run, children link to their parent, model changes are recorded, and unreported metadata stays unknown",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/runs/service.ts",
            "apps/server/src/features/runs/mcp.ts",
            "apps/server/src/features/runs/rest.ts",
            "packages/contract/src/runs.ts",
            "packages/contract/src/mcp-tools.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0019_perpetual_wallop.sql",
        ],
    )


def check_m17(facts: dict[str, Any]) -> CheckResult:
    """#36: one active claim per issue, DB-time five-minute expiry, progress kept, and
    fenced agent writes. Two agents (A, B) and two issues keep the state space small;
    every transition consults a guard extracted from the live service, projects fence and
    schema, so a deleted guard produces a shortest trace naming the exact operation."""
    unique = facts["m17_unique_index"]
    lock = facts["m17_issue_lock"]
    lazy = facts["m17_lazy_expiry"]
    db_time = facts["m17_db_time_lease"]
    keep_progress = facts["m17_progress_independent"]
    fenced = facts["m17_fenced_write"]
    no_claim = facts["m17_gate_no_claim"]
    no_nested = facts["m17_no_nested_tx"]
    renew_active = facts["m17_renew_active"]
    recheck = facts["m17_recheck_access"]
    identity = facts["m17_session_identity"]
    shared = facts["m17_helper_shares"]
    ready_db = facts["m17_ready_db_time"]
    unfenced = facts["m17_unfenced"]
    adapters = facts["m17_adapters"]
    tools_ok = facts["m17_tools"] and facts["m17_problems"]

    KEYS = ("owner", "status", "lease", "progress", "needs")

    def upd(sessions, i, **changes):
        rows = [dict(zip(KEYS, s)) for s in sessions]
        rows[i].update(changes)
        return tuple(tuple(row[k] for k in KEYS) for row in rows)

    def bad(violations, reason):
        return violations | {reason}

    def claim(sessions, levels, violations, who, i):
        owner, status, _, _, _ = sessions[i]
        if not lock:
            violations = bad(violations, "unserialized_claim")
        if levels[0 if who == "A" else 1] != "contribute":
            return sessions, violations
        if status == "active":
            if owner == who:
                return sessions, (violations if shared else bad(violations, "helper_duplicate_session"))
            return sessions, (violations if unique and lock else bad(violations, "two_active_sessions"))
        return upd(sessions, i, owner=who, status="active", lease="fresh"), violations

    def touch_lease(sessions, violations, state):
        """Expire a lapsed active session lazily; progress is a separate column."""
        s0, s1 = sessions
        v = violations
        for i, s in enumerate((s0, s1)):
            if s[1] == "active" and s[2] == "lapsed" and state == "expire":
                sessions = upd(sessions, i, status="expired", owner=None, lease="lapsed")
                if not keep_progress:
                    sessions = upd(sessions, i, progress="")
                    v = bad(v, "progress_erased")
        return sessions, v

    def renew(sessions, levels, violations, who, i, replacement=False):
        owner, status, lease, _, _ = sessions[i]
        v = violations
        level = levels[0 if who == "A" else 1]
        if level == "read":
            if recheck:
                return sessions, v
            # A stale identity could still renew after a downgrade: access survived.
            if status == "active" and owner == who and lease == "fresh":
                return sessions, bad(v, "renewed_after_downgrade")
            return sessions, v
        if not recheck:
            return sessions, bad(v, "renew_without_recheck")
        if status != "active" or owner != who:
            if not renew_active:
                return upd(sessions, i, owner=who, status="active", lease="fresh"), bad(v, "stale_write_became_claim")
            return sessions, v
        if lease == "lapsed":
            if not db_time or not renew_active:
                return upd(sessions, i, lease="fresh"), bad(v, "renewed_expired_claim")
            return touch_lease(sessions, v, "expire")[0], v
        if replacement and not identity:
            return sessions, bad(v, "replacement_key_refused")
        return upd(sessions, i, lease="fresh"), v

    def fenced_write(sessions, levels, violations, who, i, action):
        owner, status, lease, _, _ = sessions[i]
        v = violations
        if levels[0 if who == "A" else 1] == "read":
            return sessions, v
        if status == "active" and owner == who and lease == "fresh":
            return sessions, v
        if lease == "lapsed" and status == "active":
            if db_time and lazy and renew_active:
                sessions, v = touch_lease(sessions, v, "expire")
                return sessions, v
            return sessions, bad(v, "stale_write_accepted")
        if not fenced or not no_claim:
            return sessions, bad(v, f"{action}_without_session")
        return sessions, v

    def tick(sessions, violations):
        if not db_time:
            return sessions, violations
        rows = [dict(zip(KEYS, row)) for row in sessions]
        for row in rows:
            if row["status"] == "active":
                row["lease"] = "lapsed"
        return tuple(tuple(row[k] for k in KEYS) for row in rows), violations

    def progress(sessions, levels, violations):
        owner, status, lease, _, _ = sessions[0]
        if levels[0] == "read":
            return sessions, violations
        if status == "active" and owner == "A" and lease == "fresh":
            return upd(sessions, 0, progress="p"), violations
        if lease == "lapsed" and status == "active":
            if db_time and lazy and renew_active:
                return touch_lease(sessions, violations, "expire")
            return sessions, bad(violations, "stale_progress_accepted")
        if not fenced or not no_claim:
            return sessions, bad(violations, "progress_without_session")
        return sessions, violations

    def downgrade(sessions, levels, violations):
        return sessions, ("read", levels[1]), violations

    actions = [
        ("A claims issue 1", lambda s, l, v: claim(s, l, v, "A", 0)),
        ("B races A by claiming issue 1", lambda s, l, v: claim(s, l, v, "B", 0)),
        ("B claims issue 2 in its own run", lambda s, l, v: claim(s, l, v, "B", 1)),
        ("five minutes pass in database time", lambda s, l, v: tick(s, v)),
        ("A renews its live claim", lambda s, l, v: renew(s, l, v, "A", 0)),
        ("B renews issue 1 while A holds it", lambda s, l, v: renew(s, l, v, "B", 0)),
        ("a replacement key for A renews the same session", lambda s, l, v: renew(s, l, v, "A", 0, replacement=True)),
        ("A reports progress on issue 1", lambda s, l, v: progress(s, l, v)),
        ("A edits issue 1", lambda s, l, v: fenced_write(s, l, v, "A", 0, "edit")),
        ("A stops issue 1", lambda s, l, v: fenced_write(upd(s, 0, status="completed", owner=None) if s[0][1] == "active" and s[0][0] == "A" and s[0][2] == "fresh" else s, l, v, "A", 0, "stop")),
        ("A's grant is downgraded to Read", lambda s, l, v: downgrade(s, l, v)),
        ("A creates an issue, comment and knowledge without a session", lambda s, l, v: (s, v if unfenced else bad(v, "unfenced_refused"))),
        ("issue 1 is paused for input", lambda s, l, v: (upd(s, 0, needs=True), v)),
        ("the ready-work listing is read", lambda s, l, v: (s, v if _ready_ok(s, ready_db) else bad(v, "ready_listing_wrong"))),
        ("the five-minute lease deadline is computed in database time", lambda s, l, v: (s, v if db_time else bad(v, "lease_not_db_time"))),
        ("the fenced gate evaluates liveness on the caller's transaction", lambda s, l, v: (s, v if no_nested else bad(v, "nested_transaction_pool_starvation"))),
        ("both adapters authenticate the bearer key", lambda s, l, v: (s, v if adapters else bad(v, "unauthenticated_adapter"))),
        ("session tools are exposed with validated problems", lambda s, l, v: (s, v if tools_ok else bad(v, "session_tools_missing"))),
    ]

    def _ready_ok(sessions, guard):
        for _, status, lease, _, needs in sessions:
            claimed = status == "active" and (lease == "fresh" or not guard)
            # A paused issue is never ready; a lapsed lease is not a live claim in DB time.
            if needs and guard:
                continue
            if claimed and guard:
                continue
            if not guard and (needs or claimed):
                return False
        return True

    init = (
        ((None, "none", "fresh", "", False), (None, "none", "fresh", "", False)),
        ("contribute", "contribute"),
        frozenset(),
    )

    def next_states(state):
        sessions, levels, violations = state
        result = []
        for idx, (label, action) in enumerate(actions):
            if idx == 10:  # downgrade action returns a 3-tuple of its own
                nsessions, nlevels, nviolations = action(sessions, levels, violations)
                result.append((label, (nsessions, nlevels, nviolations)))
                continue
            nsessions, nviolations = action(sessions, levels, violations)
            result.append((label, (nsessions, levels, nviolations)))
        return result

    def inv(state):
        if state[2]:
            reason = sorted(state[2])[0]
            return False, f"work-session invariant broken: {reason}"
        for owner, status, _, _, _ in state[0]:
            if status == "active" and owner is None:
                return False, "an active session has no owning agent"
        return True, ""

    return bfs_check(
        "M17",
        "Work Sessions and Claims (#36)",
        "At most one active session per issue; five-minute DB-time expiry releases only that claim and keeps progress; fenced agent writes and renewal need a live session held by the agent; a downgrade stops both; ready work omits claimed and Needs input issues",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/work-sessions/rest.ts",
            "apps/server/src/features/work-sessions/mcp.ts",
            "apps/server/src/features/work-sessions/index.ts",
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/projects/rest.ts",
            "packages/contract/src/sessions.ts",
            "packages/contract/src/mcp-tools.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0022_spooky_barracuda.sql",
        ],
    )


def check_m18(facts: dict[str, Any]) -> CheckResult:
    """#40: resume is a read that distinguishes a live claim from an expired one without
    resurrecting it; progress survives interruption and is carried into reacquisition;
    reacquisition needs an expired claim of the same run and an available issue; stale
    renew/progress/write/completion never become a fresh claim; retries do not duplicate.
    Every transition consults a guard extracted from the live service/adapters/contract,
    so a deleted guard yields a shortest trace naming the exact operation."""
    read_only = facts["m18_resume_read_only"]
    resume_db_time = facts["m18_resume_db_time"]
    keeps_progress = facts["m18_resume_keeps_progress"]
    stale_rejected = facts["m18_stale_rejected"]
    db_time = facts["m18_db_time_liveness"]
    available = facts["m18_reacquire_available"]
    expired_only = facts["m18_reacquire_expired_only"]
    carry = facts["m18_reacquire_carries_progress"]
    fresh = facts["m18_reacquire_fresh_session"]
    idempotent = facts["m18_idempotent"]
    adapters = facts["m18_adapters"]
    problems = facts["m18_http_problems"]
    fence_guard = facts["m18_session_fence"]
    closed_guard = facts["m18_closed_refused"]
    update_db_time = facts["m18_update_db_time"]
    find_active_db_time = facts["m18_find_active_db_time"]

    KEYS = ("owner", "gen", "status", "lease", "progress")
    MAX_SESSIONS = 2

    def rows(sessions):
        return [dict(zip(KEYS, row)) for row in sessions]

    def pack(row_list):
        return tuple(tuple(row[k] for k in KEYS) for row in row_list)

    def materialize(row_list):
        """Lazy expiry in DB time: only lapsed active rows become expired."""
        if not db_time:
            return row_list
        return [
            dict(row, status="expired")
            if row["status"] == "active" and row["lease"] == "lapsed"
            else row
            for row in row_list
        ]

    def next_gen(row_list):
        return max([row["gen"] for row in row_list] or [0]) + 1

    def run_idx(sessions, owner):
        found = [i for i, row in enumerate(rows(sessions)) if row["owner"] == owner]
        return max(found) if found else None

    def claim(sessions, violations, owner):
        rs = materialize(rows(sessions))
        active = next((i for i, row in enumerate(rs) if row["status"] == "active"), None)
        if active is not None:
            if rs[active]["owner"] == owner:
                if not idempotent and len(rs) < MAX_SESSIONS:
                    rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                    return pack(rs), violations | {"duplicate_claim_on_retry"}
                return pack(rs), violations
            return pack(rs), violations  # issue_claimed: another worker holds it
        if len(rs) < MAX_SESSIONS:
            rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
        return pack(rs), violations

    def stale_write(sessions, violations, owner, action, fence=None):
        """renew, progress, completion and fenced writes all need a live held session.
        A `fence` names the session the delayed caller started with; it must still be the
        live session, otherwise the write is refused even if this agent holds a newer one."""
        rs = materialize(rows(sessions))
        idx = next(
            (i for i, row in enumerate(rs) if row["owner"] == owner and row["status"] == "active"),
            None,
        )
        if fence is not None:
            fenced = next((i for i, row in enumerate(rs) if row["gen"] == fence), None)
            valid = (
                fenced is not None
                and rs[fenced]["owner"] == owner
                and rs[fenced]["status"] == "active"
                and rs[fenced]["lease"] == "fresh"
            )
            if not valid:
                if not fence_guard and idx is not None:
                    # Buggy: the fence is ignored and the write falls through to S2.
                    violations = violations | {"stale_fence_bypassed"}
                else:
                    return pack(rs), violations
            else:
                idx = fenced
        if idx is None:
            if not stale_rejected and len(rs) < MAX_SESSIONS:
                rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                return pack(rs), violations | {f"stale_{action}_became_claim"}
            return pack(rs), violations
        if not db_time and rs[idx]["lease"] == "lapsed":
            violations = violations | {f"expired_claim_{action}_accepted"}
            if action == "renew":
                rs[idx]["lease"] = "fresh"
            return pack(rs), violations
        if action == "renew":
            rs[idx]["lease"] = "fresh"
        elif action == "progress":
            rs[idx]["progress"] = "p"
        elif action == "stop":
            rs[idx]["status"] = "ended"
        return pack(rs), violations

    def resume(sessions, violations, owner):
        rs = rows(sessions)
        idx = run_idx(pack(rs), owner)
        disposition = "none"
        if idx is not None:
            row = rs[idx]
            if row["status"] == "active" and row["lease"] == "fresh":
                disposition = "active"
            elif row["status"] == "active" and row["lease"] == "lapsed" and not resume_db_time:
                disposition = "active"  # buggy: a lapsed lease is reported as live
            elif (row["status"] == "active" and row["lease"] == "lapsed") or row["status"] == "expired":
                disposition = "expired"
            else:
                disposition = "ended"
        out = pack(rs)
        if idx is not None and not read_only:
            # A buggy resume re-arms the lease instead of just reporting it.
            rs[idx]["status"] = "active"
            rs[idx]["lease"] = "fresh"
            out = pack(rs)
            violations = violations | {"resume_resurrected_lease"}
        if idx is not None and not resume_db_time and row["lease"] == "lapsed":
            violations = violations | {"resume_missed_expiry"}
        if idx is not None and not keeps_progress:
            violations = violations | {"resume_dropped_progress"}
        return out, violations

    def reacquire(sessions, violations, owner, needs, closed):
        rs = materialize(rows(sessions))
        active = next((i for i, row in enumerate(rs) if row["status"] == "active"), None)
        if active is not None:
            if rs[active]["owner"] == owner:
                if not idempotent and len(rs) < MAX_SESSIONS:
                    rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                    return pack(rs), violations | {"duplicate_reacquire_claim"}
                return pack(rs), violations
            if not available:
                rs[active]["owner"] = owner
                return pack(rs), violations | {"reacquire_stole_live_claim"}
            return pack(rs), violations  # issue_claimed
        idx = run_idx(pack(rs), owner)
        prior = rs[idx] if idx is not None else None
        if prior is None or prior["status"] != "expired":
            if not expired_only and len(rs) < MAX_SESSIONS:
                rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                return pack(rs), violations | {"reacquire_without_expired_claim"}
            return pack(rs), violations
        if needs or closed:
            if (not available or (closed and not closed_guard)) and len(rs) < MAX_SESSIONS:
                rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=prior["progress"]))
                reason = "reacquire_closed_issue" if closed else "reacquire_while_paused"
                return pack(rs), violations | {reason}
            return pack(rs), violations  # issue_blocked
        if len(rs) >= MAX_SESSIONS:
            return pack(rs), violations
        gen = prior["gen"] if not fresh else next_gen(rs)
        progress = prior["progress"] if carry else ""
        violations = violations | (set() if carry else {"progress_lost_on_reacquire"})
        if gen == prior["gen"]:
            violations = violations | {"lease_resurrected"}
        rs.append(dict(owner=owner, gen=gen, status="active", lease="fresh", progress=progress))
        return pack(rs), violations

    def step(fn):
        """Adapt a (sessions, violations) -> (sessions, violations) step to full state."""
        def action(s, c, n, v):
            ns, nv = fn(s, v)
            return (ns, c, n, nv)
        return action

    def step_flags(fn):
        """Adapt a (sessions, violations, needs, closed) -> (sessions, violations) step."""
        def action(s, c, n, v):
            ns, nv = fn(s, v, n, c)
            return (ns, c, n, nv)
        return action

    actions = [
        ("the original run claims the issue", step(lambda s, v: claim(s, v, "R"))),
        ("another worker claims the issue", step(lambda s, v: claim(s, v, "S"))),
        ("five minutes pass in database time", lambda s, c, n, v: (pack([dict(row, lease="lapsed") if row["status"] == "active" else row for row in rows(s)]), c, n, v)),
        ("the original run resumes its conversation", step(lambda s, v: resume(s, v, "R"))),
        ("a stale renewal arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "renew"))),
        ("a stale progress report arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "progress"))),
        ("a stale completion arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "stop"))),
        ("a stale fenced issue write arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "edit"))),
        ("a delayed renewal fenced to session 1", step(lambda s, v: stale_write(s, v, "R", "renew", fence=1))),
        ("a delayed progress report fenced to session 1", step(lambda s, v: stale_write(s, v, "R", "progress", fence=1))),
        ("a delayed completion fenced to session 1", step(lambda s, v: stale_write(s, v, "R", "stop", fence=1))),
        ("the other worker renews its live claim", step(lambda s, v: stale_write(s, v, "S", "renew"))),
        ("the other worker completes its live claim", step(lambda s, v: stale_write(s, v, "S", "stop"))),
        ("the original run reacquires its expired claim", step_flags(lambda s, v, n, c: reacquire(s, v, "R", n, c))),
        ("the other worker reacquires its expired claim", step_flags(lambda s, v, n, c: reacquire(s, v, "S", n, c))),
        ("the issue is paused for input", lambda s, c, n, v: (s, c, True, v)),
        ("the input is answered", lambda s, c, n, v: (s, c, False, v)),
        ("the issue is closed", lambda s, c, n, v: (s, True, n, v)),
        ("the issue is reopened", lambda s, c, n, v: (s, False, n, v)),
        ("renew/progress/stop recheck DB-time liveness on UPDATE and findActive", lambda s, c, n, v: (s, c, n, v if update_db_time and find_active_db_time else v | {"lapsed_row_updated"})),
        ("resume/reacquire tools are exposed with validated problems", lambda s, c, n, v: (s, c, n, v if adapters and problems else v | {"tools_or_problems_missing"})),
    ]

    init = ((), False, False, frozenset())

    def inv(state):
        sessions, _, _, violations = state
        if violations:
            reason = sorted(violations)[0]
            return False, f"resume/reacquire invariant broken: {reason}"
        actives = [row for row in rows(sessions) if row["status"] == "active"]
        if len(actives) > 1:
            return False, "two active sessions hold the same issue"
        return True, ""

    return bfs_check(
        "M18",
        "Resume, Reacquisition and Stale Sessions (#40)",
        "Resume is a DB-time read that distinguishes live from expired claims without resurrecting them; progress survives interruption and reacquisition; a run reacquires only its own expired claim on an available issue; stale renew/progress/fenced writes/completions never become fresh claims; retries do not duplicate a claim",
        "safety",
        init,
        lambda state: [(label, action(*state)) for label, action in actions],
        inv,
        [
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/work-sessions/rest.ts",
            "apps/server/src/features/work-sessions/mcp.ts",
            "packages/contract/src/sessions.ts",
            "packages/contract/src/mcp-tools.ts",
        ],
    )


def check_m19(facts: dict[str, Any]) -> CheckResult:
    """#37: removal / voluntary leave revoke keys and grants and release active claims in
    one transaction, a renewal racing the departure cannot retain the claim, the last owner
    and a personal workspace cannot be left, re-invitation starts with fresh grants but the
    old key stays dead, and comments/attribution survive. Behavioral guards are explored by
    BFS; structural guards (lock order, no nested transaction, the thin REST leave route)
    are asserted from the extracted facts."""
    files = [
        "apps/server/src/features/workspaces/service.ts",
        "apps/server/src/features/workspaces/rest.ts",
        "apps/server/src/features/work-sessions/service.ts",
        "apps/server/src/features/agents/service.ts",
        "apps/server/src/features/projects/service.ts",
        "apps/server/src/features/index.ts",
        "apps/server/src/db/schema.ts",
        "db/migrations/0023_wealthy_silvermane.sql",
    ]
    structural = (
        "m19_issue_lock_order",
        "m19_no_nested_tx",
        "m19_active_only",
        "m19_release_status_guard",
        "m19_membership_lock",
        "m19_personal_scope",
        "m19_single_tx",
        "m19_leave_route",
    )
    missing = [name for name in structural if not facts[name]]
    if missing:
        return CheckResult(
            "M18",
            "Member Removal, Leave & Claim Release (#37)",
            "Departure revokes credentials and grants, releases claims, and a racing renewal cannot retain one",
            "safety",
            "violated",
            0,
            0,
            "M18 structural guard missing: " + ", ".join(missing),
            [f"remove the {name} guard from the #37 cleanup" for name in missing],
            files,
        )

    release_remove = facts["m19_release_in_remove"]
    release_leave = facts["m19_release_in_leave"]
    recheck = facts["m19_recheck_membership"]
    revoke_keys = facts["m19_revoke_keys"]
    revoke_grants = facts["m19_revoke_grants"]
    last_owner = facts["m19_last_owner_leave"]
    personal_guard = facts["m19_personal_not_leavable"]
    distinct = facts["m19_distinct_events"]
    keep_comments = facts["m19_attribution_kept"]

    def depart(state, event, guard):
        member, kind, is_owner, owners, key, grant, session, comments, events, inflight = state
        if revoke_keys:
            key = "revoked"
        if revoke_grants:
            grant = "revoked"
        if session == "active" and guard:
            session = "released"
        if not keep_comments:
            comments = 0
        if distinct:
            events = events | {event}
        return (False, kind, is_owner, owners, key, grant, session, comments, events, inflight)

    def removal(state):
        if not state[0] or state[1] != "shared":
            return state
        return depart(state, "member_removed", release_remove)

    def leave(state):
        member, kind, is_owner, owners, *_ = state
        if not member or kind != "shared":
            return state
        if is_owner and owners <= 1 and last_owner:
            return state
        next_state = depart(state, "owner_left" if is_owner else "member_left", release_leave)
        updated = list(next_state)
        updated[3] = owners - 1 if is_owner else owners
        return tuple(updated)

    def single_owner_context(state):
        # A shared workspace whose only owner is the caller: the last-owner safeguard is
        # the only thing between this and an unadministrable workspace.
        return (True, "shared", True, 1, "valid", "present", "active", 1, frozenset(), None)

    def personal_context(state):
        # A fresh personal-workspace scenario: one owner, no membership row and a live
        # agent claim. It starts its own history so the shared-workspace timeline above
        # cannot leak a "revived key" signal into this independent context.
        return (True, "personal", True, 1, "valid", "present", "active", 1, frozenset(), None)

    def leave_personal(state):
        if state[1] != "personal" or not state[0] or personal_guard:
            return state
        return depart(state, "owner_left", release_leave)

    def renew_start(state):
        if state[0] and state[6] == "active":
            updated = list(state)
            updated[9] = "renew"
            return tuple(updated)
        return state

    def renew_commit(state):
        if state[9] is None:
            return state
        updated = list(state)
        updated[9] = None
        if not state[0] and not recheck:
            # The in-flight renewal extends a claim whose human has already departed.
            updated[6] = "active"
        return tuple(updated)

    def reinvite(state):
        if state[0]:
            return state
        updated = list(state)
        updated[0] = True
        updated[2] = False
        updated[4] = "revoked" if revoke_keys else state[4]
        updated[5] = "fresh"
        updated[8] = state[8] | {"member_joined"}
        return tuple(updated)

    def add_comment(state):
        updated = list(state)
        updated[7] = min(2, state[7] + 1)
        return tuple(updated)

    actions = [
        ("an authorized owner removes the member", removal),
        ("the member leaves voluntarily", leave),
        ("a renewal starts before the departure", renew_start),
        ("the in-flight renewal commits after removal", renew_commit),
        ("the member is re-invited with fresh grants", reinvite),
        ("a comment keeps the issue's agent attribution", add_comment),
        ("context: a personal workspace with one owner and a live claim", personal_context),
        ("the personal owner tries to leave", leave_personal),
        ("context: a shared workspace with one owner and a live claim", single_owner_context),
        ("the last owner tries to leave the shared workspace", leave),
    ]
    init = (True, "shared", False, 2, "valid", "present", "active", 1, frozenset(), None)

    def next_states(state):
        return [(label, action(state)) for label, action in actions]

    def inv(state):
        member, kind, is_owner, owners, key, grant, session, comments, events, _ = state
        if kind == "shared" and owners < 1:
            return False, "shared workspace ended with no owner (last-owner guard missing)"
        if kind == "personal" and not member:
            return False, "personal workspace lost its owner (leave was allowed)"
        if not member:
            if key == "valid":
                return False, "removed member's agent key is still valid"
            if grant == "present":
                return False, "removed member still holds project access"
            if session == "active":
                return False, "removed member's agent retained an active claim"
            if not events:
                return False, "departure wrote no audit event"
        if "member_removed" in events and "member_joined" in events and key == "valid":
            return False, "pre-removal key revived on re-invitation"
        if comments < 1:
            return False, "departure erased the issue comment and its agent attribution"
        return True, ""

    return bfs_check(
        "M19",
        "Member Removal, Leave & Claim Release (#37)",
        "Removal/leave revoke keys and grants, release active claims in one transaction, block a racing renewal, protect the last owner and personal work, and keep audit and comments",
        "safety",
        init,
        next_states,
        inv,
        files,
    )


def check_m20(facts: dict[str, Any]) -> CheckResult:
    """#41: the three-resolution question lifecycle (open -> answered | paused |
    fallback_used, with paused -> answered). The fixed model is proven deadlock-free and
    exactly-once in database time; the same explorer run with the naive two-state timeout
    guards MUST deadlock a paused issue, which is the sensitivity proof for this model.

    State: (question status, issues.needs_input, claim, clock vs deadline, violations).
    Every transition below consults a guard extracted from the live service/contract.
    """
    guards = {
        "statuses": facts["m20_statuses"],
        "lock": facts["m20_issue_lock"],
        "db_time": facts["m20_db_time"],
        "once": facts["m20_exact_once"],
        "release": facts["m20_release_pause"],
        "unblock": facts["m20_paused_unblock"],
        "needs": facts["m20_needs_sync"],
        "no_nested": facts["m20_no_nested"],
        "human": facts["m20_human_only"],
        "email": facts["m20_email_after_commit"],
        "history": facts["m20_history"],
        "claim": facts["m20_claim_bounded"],
        "adapters": facts["m20_adapters"],
        "lock_order": facts["m20_lock_order"],
        "non_enumeration": facts["m20_non_enumeration"],
        "scoped_list": facts["m20_scoped_list"],
        "db_time_reads": facts["m20_db_time_reads"],
        "ask_scope": facts["m20_ask_scope"],
        "boundary_guard": facts["m20_boundary_guard"],
        "read_tool": facts["m20_read_tool"],
        "feature_seams": facts["m20_feature_seams"],
    }

    def explore(g: dict[str, bool], naive: bool) -> CheckResult:
        # The naive variant is the same explorer with every guard turned off: the 2-state
        # open -> answered | timed_out design from the literal reading of #20.
        g = {key: False for key in g} if naive else g
        init = ("open", True, "held", "before", frozenset())

        def transitions(state):
            status, needs, claim, clock, violations = state
            out: list[tuple[str, Any]] = []

            def go(label, nstatus, nneeds, nclaim, nclock, extra=frozenset()):
                out.append((label, (nstatus, nneeds, nclaim, nclock, violations | extra)))

            def bad(*reasons):
                return frozenset(reasons)

            if naive:
                # The literal 2-state reading of #20: open -> answered | timed_out, where a
                # post-deadline answer is follow-up only. This is the buggy variant whose
                # deadlock the fixed model must be shown to avoid.
                if clock == "before":
                    go("one-hour deadline passes in database time", status, needs, claim, "after")
                if claim == "held":
                    go("five-minute claim lapses without check-in", status, needs, "released", clock)
                if status == "open" and clock == "before":
                    go("human answers before the deadline", "answered", False, claim, clock)
                if status == "open" and clock == "after":
                    go("deadline marks the question timed_out (two-state model)", "timed_out", True, "released", clock)
                if status == "timed_out":
                    go("human answer after the deadline is stored only as a follow-up", status, needs, claim, clock)
                return out

            # Database time moves independently of any process: at/after the deadline an
            # answer is no longer "on time", even if no sweeper has run.
            if clock == "before":
                go("one-hour deadline passes in database time", status, needs, claim, "after")

            # A lapsed five-minute lease releases only the claim. It never erases the
            # question and never clears Needs input.
            if claim == "held":
                go("five-minute claim lapses without check-in", status, needs, "released", clock)

            # Check-in while waiting keeps the claim, bounded by the response deadline.
            if status == "open" and claim == "held" and clock == "before":
                go(
                    "waiting agent checks in and renews its claim",
                    status,
                    needs,
                    claim,
                    clock,
                    frozenset() if g["claim"] else bad("claim_not_bounded_by_deadline"),
                )
            if status == "open" and claim == "held" and clock == "after":
                if g["db_time"] and g["release"]:
                    go("check-in at the deadline pauses and releases the claim", "paused", True, "released", clock)
                else:
                    go("check-in renews past the deadline (bug)", status, needs, claim, clock, bad("renewed_past_deadline"))

            # Atomic deadline evaluation: open -> paused in DB time, release the claim, keep
            # Needs input; no fallback is authorized in #41.
            if status == "open" and clock == "after":
                if g["db_time"] and g["release"]:
                    go("deadline evaluation pauses, releases the claim, keeps Needs input", "paused", True, "released", clock)
                else:
                    go("deadline marks timed_out without pausing (bug)", "timed_out", True, "released", clock, bad("naive_two_state_timeout"))

            # Human answer before the deadline: the only on-time resolution.
            if status == "open" and clock == "before":
                if g["once"] and g["needs"]:
                    go("human answers before the deadline", "answered", False, claim, clock)
                else:
                    go("answer leaves Needs input set (bug)", "answered", True, claim, clock, bad("answer_left_needs_input"))

            # Human answer at/after the deadline. In the 3-resolution model an answer that
            # races the boundary first pauses, then unblocks; an answer to a paused question
            # transitions paused -> answered. In the naive model it is a follow-up only.
            if clock == "after":
                if status == "open":
                    if g["db_time"] and g["unblock"] and g["release"]:
                        go("answer races the deadline: pause then answered, Needs input cleared", "answered", False, claim, clock)
                    else:
                        go("late answer is follow-up only (bug)", "timed_out", True, claim, clock, bad("paused_issue_deadlock"))
                elif status == "paused":
                    if g["unblock"] and g["needs"]:
                        go("human answers a paused question; issue unblocked for reacquisition", "answered", False, "released", clock)
                    else:
                        go("answer to paused question stays follow-up only (bug)", status, needs, claim, clock, bad("paused_issue_deadlock"))
                elif status == "timed_out":
                    go("late answer to timed_out question stays follow-up only (bug)", status, needs, claim, clock, bad("paused_issue_deadlock"))
                elif status == "fallback_used":
                    go("late answer stored as follow-up without reversing fallback work", status, needs, claim, clock)
                elif status == "answered":
                    if g["once"]:
                        go("second answer is refused: one resolution", status, needs, claim, clock)
                    else:
                        go("second answer overwrites the resolution (bug)", status, needs, claim, clock, bad("two_resolutions"))

            # Strict actor gate: agent keys (including sibling runs), Readers and unrelated
            # members can never answer.
            go("sibling agent key tries to answer", status, needs, claim, clock,
               frozenset() if g["human"] else bad("agent_answered"))
            go("reader or unrelated member tries to answer", status, needs, claim, clock,
               frozenset() if g["human"] else bad("unauthorized_answered"))

            # Ready work and reacquisition must respect Needs input.
            if needs and not g["needs"]:
                go("ready-work listing offers a Needs input issue (bug)", status, needs, claim, clock, bad("needs_input_offered_as_ready"))
            else:
                go("ready-work listing omits Needs input issues", status, needs, claim, clock)
            if needs:
                go("agent tries to claim a Needs input issue", status, needs, claim, clock,
                   frozenset() if g["claim"] else bad("claimed_needs_input_issue"))
            elif claim == "released":
                go("agent reacquires the claim after the answer", status, needs, "held", clock)

            # Static source guards: their absence is itself a violation trace.
            if not g["statuses"]:
                go("schema uses a naive two-state resolution (bug)", status, needs, claim, clock, bad("no_paused_or_fallback_resolution"))
            if not g["lock"]:
                go("question write without an issue FOR UPDATE lock (bug)", status, needs, claim, clock, bad("unlocked_question_write"))
            if not g["no_nested"]:
                go("nested transaction while holding the issue row lock (bug)", status, needs, claim, clock, bad("nested_transaction"))
            if not g["email"]:
                go("owner email sent inside the DB lock (bug)", status, needs, claim, clock, bad("email_inside_lock"))
            if not g["history"]:
                go("question and resolution missing from history (bug)", status, needs, claim, clock, bad("question_not_in_history"))
            if not g["adapters"]:
                go("ask tool or REST validation missing (bug)", status, needs, claim, clock, bad("adapters_missing"))
            if not g["lock_order"]:
                go("deadline evaluation locks questions before the issue (bug)", status, needs, claim, clock, bad("lock_order_deadlock"))
            if not g["non_enumeration"]:
                go("unrelated caller learns a question exists via 403 (bug)", status, needs, claim, clock, bad("cross_workspace_existence_leak"))
            if not g["scoped_list"]:
                go("global LIMIT hides another workspace's inbox (bug)", status, needs, claim, clock, bad("inbox_cross_workspace_starvation"))
            if not g["db_time_reads"]:
                go("read reports open past the deadline (bug)", status, needs, claim, clock, bad("stale_open_on_read"))
            if not g["ask_scope"]:
                go("sibling run or closed issue asked a question (bug)", status, needs, claim, clock, bad("unscoped_ask"))
            if not g["boundary_guard"]:
                go("answer or follow-up lacks its DB-time guard (bug)", status, needs, claim, clock, bad("missing_boundary_guard"))
            if not g["read_tool"]:
                go("agent cannot read the answer back over MCP (bug)", status, needs, claim, clock, bad("no_mcp_read_tool"))
            if not g["feature_seams"]:
                go("work sessions bypasses the inbox public interface (bug)", status, needs, claim, clock, bad("seams_bypassed"))
            return out

        def invariant(state):
            status, needs, claim, clock, violations = state
            if naive and status == "timed_out":
                return False, "paused_issue_deadlock: a human answer at or after 1h is only a follow-up, so a paused issue stays Needs input forever"
            if violations:
                return False, "3-resolution question invariant broken: " + sorted(violations)[0]
            if status in ("open", "paused", "timed_out") and not needs:
                return False, "Needs input was lost while the question is unresolved"
            if status == "answered" and needs:
                return False, "an answered issue is still Needs input"
            if status == "paused" and claim == "held":
                return False, "a paused issue still holds the claim"
            return True, ""

        return bfs_check(
            "M18-naive" if naive else "M20",
            "Three-Resolution Question Lifecycle (#41)",
            "Naive two-state timeout deadlocks paused issues" if naive else
            "One DB-time resolution; a paused issue is unblocked by a human answer, keeps Needs input until then, and only humans may answer",
            "liveness" if naive else "safety",
            init,
            transitions,
            invariant,
            [
                "apps/server/src/features/inbox/service.ts",
                "apps/server/src/features/inbox/rest.ts",
                "apps/server/src/features/inbox/mcp.ts",
                "apps/server/src/features/work-sessions/service.ts",
                "apps/server/src/features/work-sessions/index.ts",
                "apps/server/src/features/index.ts",
                "packages/contract/src/questions.ts",
                "packages/contract/src/mcp-tools.ts",
                "apps/server/src/db/schema.ts",
                "db/migrations/0024_white_rage.sql",
            ],
        )

    fixed = explore(guards, False)
    naive = explore(guards, True)

    files = fixed.files
    if fixed.status != "verified":
        return fixed
    if naive.status != "violated":
        return CheckResult(
            "M20",
            "Three-Resolution Question Lifecycle (#41)",
            "Sensitivity: the naive 2-state model must deadlock a paused issue",
            "safety",
            "violated",
            fixed.states_explored,
            fixed.transitions_explored,
            "The buggy two-state variant was not detected; the model is not sensitive.",
            [],
            files,
        )
    return CheckResult(
        "M20",
        "Three-Resolution Question Lifecycle (#41)",
        "One DB-time resolution; a paused issue is unblocked by a human answer, keeps Needs input until then, and only humans may answer",
        "safety",
        "verified",
        fixed.states_explored + naive.states_explored,
        fixed.transitions_explored + naive.transitions_explored,
        f"Verified across {fixed.states_explored} reachable states ({fixed.transitions_explored} transitions); "
        f"sensitivity: the naive 2-state variant is violated at '{naive.summary.split(': ')[-1]}' "
        f"with trace: {' -> '.join(naive.counterexample[:4])}.",
        [],
        files,
    )


def check_m21(facts: dict[str, Any]) -> CheckResult:
    """#39: a personal-to-shared transfer is atomic, rechecks both authorities and the
    project's current ownership, blocks live work in database time, and leaves no source
    key, source grant or pending offer behind. Destination membership gates every reveal
    of a destination's name and owners: the source owner's authorization carries no PII
    for a stranger, and a separate Create-projects receiver can preview the pending token
    before accepting. Each transition consults a source-extracted guard; flipping one
    produces a shortest counterexample naming the exact broken operation."""
    g = facts

    def bad(violations: frozenset[str], reason: str) -> frozenset[str]:
        return violations | {reason}

    def apply_transfer(state, violations):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        v = violations

        # One transaction, ownership lock first, workspace guards before the project row
        # and issues, all on the same transaction.
        if not g["m21_single_tx"]:
            v = bad(v, "accept_split_across_transactions")
        if not g["m21_lock_first"]:
            v = bad(v, "ownership_lock_not_first")
        if not g["m21_guard_order"]:
            v = bad(v, "workspace_guards_not_ordered_before_project")
        if not g["m21_issue_lock"]:
            v = bad(v, "issues_not_locked_before_active_work_check")
        if not g["m21_preserve_identity"]:
            v = bad(v, "authorship_rewritten_on_move")

        # Cleanup: source grants, source keys' project scope and only still-pending offers.
        if not g["m21_grant_cleanup"]:
            v = bad(v, "source_grant_survived")
        else:
            grants = grants - {"old"}
        if not g["m21_key_cleanup"]:
            v = bad(v, "source_key_followed_project")
        else:
            keys = False
        if not g["m21_offer_cleanup"] or not g["m21_pending_offers_only"]:
            v = bad(v, "pending_offer_not_invalidated")
        else:
            offers = False
        if not g["m21_expire_lapsed"]:
            v = bad(v, "stale_active_session_moved")
        if not g["m21_revoke_siblings"]:
            v = bad(v, "sibling_authorization_left_pending")

        # Rebuild access and the destination's own audit trail; source events stay source.
        if not g["m21_grant_rebuild"]:
            v = bad(v, "destination_manage_grants_missing")
        else:
            grants = grants | {"dest"}
        if not g["m21_grant_events"]:
            v = bad(v, "destination_grant_events_missing")
        if not g["m21_receipt_events"]:
            v = bad(v, "destination_receipt_missing")
        if not g["m21_source_events_scoped"]:
            v = bad(v, "source_access_history_leaked_to_destination")
        events = events | {"dest_grants", "receipt", "source_out"}

        return ("transferred", "accepted", dest_ok, dest_member, source_ok, "dest",
                "none", keys, grants, events, offers, auth_live, v)

    def preview(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if not g["m21_preview"]:
            v = bad(v, "no_preview_before_confirmation")
        if not g["m21_http_problems"]:
            v = bad(v, "validated_route_without_400_problem")
        if not g["m21_human_only"]:
            v = bad(v, "agent_key_can_authorize_transfer")
        if not dest_member and not g["m21_dest_membership_preview"]:
            v = bad(v, "destination_enumerated_by_preview")
        return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def lose_source(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, False, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def join_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, False, True, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def leave_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, False, False, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def gain_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, True, True, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def lose_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, False, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def authorize(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "start":
            return state
        if not source_ok:
            if not g["m21_source_owner"]:
                v = bad(v, "authorized_without_source_ownership")
            else:
                return state  # correctly refused
        if not dest_ok and not g["m21_two_party"]:
            v = bad(v, "two_party_authorization_required_destination_authority")
        if not g["m21_authorization_persisted"]:
            v = bad(v, "authorization_not_persisted")
        if not dest_member and not g["m21_authorize_redaction"]:
            v = bad(v, "destination_owner_pii_leaked")
        return ("authorized", "pending", dest_ok, dest_member, source_ok, pws,
                claim, keys, grants, events, offers, True, v)

    def receiver_preview(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "authorized" or auth != "pending":
            return state
        if not g["m21_receiver_preview"]:
            v = bad(v, "no_receiver_preview")
        if not dest_member or not dest_ok:
            if not g["m21_receiver_authority"]:
                v = bad(v, "unauthorized_receiver_saw_preview")
        elif not g["m21_receiver_recipient"]:
            v = bad(v, "receiver_not_listed_for_acceptor")
        return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def claim(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, pws, "live", keys,
                grants, events, offers, auth_live, v)

    def expire_claim(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, pws, "expired", keys,
                grants, events, offers, auth_live, v)

    def expire_auth(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, False, v)

    def move_project(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, "elsewhere", claim,
                keys, grants, events, offers, auth_live, v)

    def accept(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "authorized" or auth != "pending":
            return state
        if not g["m21_authorization_persisted"]:
            v = bad(v, "accept_without_persisted_authorization")
        if not auth_live:
            if not g["m21_db_time_expiry"]:
                return apply_transfer(state, bad(v, "expired_authorization_accepted"))
            return state
        if not dest_member:
            if not g["m21_accept_membership"]:
                return apply_transfer(state, bad(v, "non_member_accepted_transfer"))
            return state
        if not source_ok:
            if not g["m21_recheck_source"]:
                return apply_transfer(state, bad(v, "accepted_after_source_lost"))
            return state
        if not dest_ok:
            if not g["m21_recheck_authority"]:
                return apply_transfer(state, bad(v, "accepted_after_destination_authority_lost"))
            return state
        if dest_ok and not g["m21_dest_authority"]:
            v = bad(v, "valid_destination_authority_refused")
        if pws != "source":
            if not g["m21_recheck_workspace"]:
                return apply_transfer(state, bad(v, "accepted_after_workspace_changed"))
            return state
        if claim == "live":
            if not (g["m21_active_work"] and g["m21_db_time_live"]):
                return apply_transfer(state, bad(v, "transferred_with_live_work"))
            return state
        if claim == "expired" and not g["m21_db_time_live"]:
            v = bad(v, "expired_claim_blocked_transfer")
        return apply_transfer(state, v)

    def complete(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "start" or not source_ok:
            return state
        if not dest_member:
            if not g["m21_dest_membership_complete"]:
                v = bad(v, "complete_enumerated_destination")
            return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                    grants, events, offers, auth_live, v)
        if not dest_ok:
            return state
        if not g["m21_dest_authority"]:
            v = bad(v, "direct_flow_denied_valid_authority")
        if pws != "source":
            return state
        if claim == "live" and not (g["m21_active_work"] and g["m21_db_time_live"]):
            return apply_transfer(state, bad(v, "transferred_with_live_work"))
        if claim == "live":
            return state
        return apply_transfer(state, v)

    actions = [
        ("the personal owner previews the destination, access changes and live work", preview),
        ("a stranger or non-authority member previews the pending token", receiver_preview),
        ("the authorizing owner loses the source workspace", lose_source),
        ("the receiver joins the destination without Create projects", join_dest),
        ("a member leaves the destination", leave_dest),
        ("the destination grants Create projects to the receiver", gain_dest),
        ("destination Create projects authority is withdrawn", lose_dest),
        ("the source owner authorizes without destination authority", authorize),
        ("a worker claims an issue on the project", claim),
        ("the claim's lease lapses in database time", expire_claim),
        ("the authorization expires in database time", expire_auth),
        ("the project moves to another workspace before acceptance", move_project),
        ("the destination owner or Create projects member accepts", accept),
        ("one person with both authorities completes directly", complete),
    ]

    init = ("start", "none", False, False, True, "source", "none", True,
            frozenset({"old"}), frozenset(), True, True, frozenset())

    def next_states(state):
        return [(label, action(state)) for label, action in actions]

    def inv(state):
        v = state[-1]
        if v:
            return False, f"project-transfer invariant broken: {sorted(v)[0]}"
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, _) = state
        if phase == "transferred":
            if keys:
                return False, "a source key still names the moved project"
            if "old" in grants:
                return False, "a source grant survived the move"
            if "dest" not in grants:
                return False, "destination Manage grants were not rebuilt"
            if "receipt" not in events or "dest_grants" not in events:
                return False, "destination recorded no receipt and grant events"
            if offers:
                return False, "a pending offer still names the moved project"
        if phase == "authorized" and auth != "pending":
            return False, "an authorization left pending is not pending"
        return True, ""

    return bfs_check(
        "M21",
        "Personal-to-Shared Project Transfer (#39)",
        "Destination membership gates every reveal of its name and owners, including a redacted source-owner authorization and a receiver-only preview; acceptance is one transaction that rechecks both authorities, current ownership and no live DB-time work, expires lapsed leases, keeps settled offers, revokes rival tokens, rebuilds destination Manage and receipts, and removes source keys, grants and pending offers",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/transfers/service.ts",
            "apps/server/src/features/transfers/rest.ts",
            "apps/server/src/features/transfers/index.ts",
            "packages/contract/src/transfers.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0025_thick_valeria_richards.sql",
        ],
    )

def check_m22(facts: dict[str, Any]) -> CheckResult:
    """Account deactivation/reactivation (#38): one atomic suspension, no revival.

    The model explores a deactivation, attempts to sign in and use a key while suspended,
    a reactivation, and a fresh invitation. Each transition consults the guards extracted
    from the live service, auth paths, contract and migration; flipping any one of them
    makes the invariant fail, which is the sensitivity proof for this model.
    """
    g = facts

    def model_bfs() -> CheckResult:
        def with_bad(v: frozenset, label: str) -> frozenset:
            return v | {label}

        # (status, active_admins, sessions, key, claim, grant, membership, is_owner,
        #  former_owner, was_owner, is_admin, revived, events, violations)
        def apply_deactivate(s):
            (status, admins, sessions, key, claim, grant, membership, is_owner,
             former, was_owner, is_admin, revived, events, v) = s
            if not g["m22_http_problems"]:
                v = with_bad(v, "undeclared_problem_response")
            if not (
                g["m22_lock_order"]
                and g["m22_account_lock"]
                and g["m22_membership_lock"]
                and g["m22_claim_account_lock"]
            ):
                v = with_bad(v, "lock_order_inversion_or_claim_race")
            if status == "deactivated":
                return s[:-1] + (v,)
            if not g["m22_deactivated_column"]:
                v = with_bad(v, "no_deactivation_marker")
            if not g["m22_suspended_column"]:
                v = with_bad(v, "no_suspended_membership_column")
            if was_owner and not g["m22_trigger"]:
                v = with_bad(v, "sole_owner_deactivation_failed")
            # Last active administrator: the guard refuses the whole transition.
            if is_admin and admins <= 1:
                if not g["m22_last_admin_guard"]:
                    v = with_bad(v, "last_admin_deactivated")
                    admins -= 1
                else:
                    return s[:-1] + (v,)
            elif is_admin:
                admins -= 1
            if not g["m22_one_tx"]:
                v = with_bad(v, "torn_deactivation")
            sessions = sessions if not g["m22_sessions_deleted"] else 0
            key = key if not g["m22_keys_revoked"] else "revoked"
            claim = claim if not g["m22_claims_released"] else "released"
            grant = grant if not g["m22_grants_revoked"] else False
            suspended = g["m22_membership_suspended"]
            # A still-suspended membership is not rewritten by a second deactivation: its
            # retained former-owner mark must survive exactly as the SQL UPDATE's
            # suspended_at IS NULL guard preserves it.
            if suspended and membership != "suspended":
                membership, new_owner, new_former = "suspended", False, is_owner
            else:
                new_owner, new_former = is_owner, former
            if g["m22_events"]:
                events = events | {"account_deactivated"}
            return ("deactivated", admins, sessions, key, claim, grant, membership,
                    new_owner, new_former, was_owner, is_admin, revived, events, v)

        def login(s):
            if s[0] == "deactivated" and not g["m22_auth_login"]:
                return s[:-1] + (with_bad(s[-1], "deactivated_login_succeeded"),)
            return s

        def use_session(s):
            if s[0] == "deactivated" and not g["m22_auth_session"]:
                return s[:-1] + (with_bad(s[-1], "deactivated_session_succeeded"),)
            return s

        def stale_issue_key(s):
            if s[0] == "deactivated" and not g["m22_key_issuance_guard"]:
                return s[:-1] + (with_bad(s[-1], "key_minted_after_deactivation"),)
            return s

        def stale_reset(s):
            if s[0] == "deactivated" and not g["m22_reset_guard"]:
                return s[:-1] + (with_bad(s[-1], "reset_link_for_deactivated"),)
            return s

        def stale_invitation(s):
            if s[0] == "deactivated" and not g["m22_invitation_recheck"]:
                return s[:-1] + (with_bad(s[-1], "invitation_accepted_while_deactivated"),)
            return s

        def use_key(s):
            v = s[-1]
            if s[0] == "deactivated" and not (g["m22_auth_key"] and g["m22_keys_revoked"]):
                v = with_bad(v, "deactivated_key_succeeded")
            if s[6] == "suspended" and not g["m22_membership_checks"]:
                v = with_bad(v, "suspended_membership_key_succeeded")
            return s[:-1] + (v,)

        def reactivate(s):
            if s[0] != "deactivated":
                return s
            (status, admins, sessions, key, claim, grant, membership, is_owner,
             former, was_owner, is_admin, revived, events, v) = s
            if not g["m22_no_restore"]:
                # The forbidden revival: shared membership, old ownership and old key come
                # back automatically. Fresh grants are indistinguishable from old ones here.
                membership, is_owner, former, grant, key = "active", was_owner, was_owner, True, "live"
            if g["m22_events"]:
                events = events | {"account_reactivated"}
            return ("active", admins, sessions, key, claim, grant, membership, is_owner,
                    former, was_owner, is_admin, True, events, v)

        def reinvite(s):
            if s[0] != "active" or not s[11]:
                return s
            if s[8]:
                # A former owner in a still ownerless workspace must be refused cleanly
                # (409) until #43 appoints a new owner, not crash the deferred trigger.
                if not g["m22_ownerless_refusal"]:
                    return s[:-1] + (with_bad(s[-1], "ownerless_rejoin_500"),)
                return s
            # A fresh invitation unsuspends the retained row with fresh access, but it never
            # restores former ownership and never unrevokes an old key.
            return (s[0], s[1], s[2], s[3], s[4], True, "active", False, False,
                    False, s[10], s[11], s[12], s[13])

        def make_non_owner(s):
            if s[0] != "active" or s[6] != "active" or s[11]:
                return s
            return (s[0], s[1], s[2], s[3], s[4], s[5], s[6], False, s[8], False,
                    s[10], s[11], s[12], s[13])

        def make_admin_with_successor(s):
            if s[0] != "active" or s[10] or s[11]:
                return s
            return (s[0], s[1] + 1, s[2], s[3], s[4], s[5], s[6], s[7], s[8],
                    s[9], True, s[11], s[12], s[13])

        def settle_claim(s):
            if s[0] != "active" or s[4] != "active":
                return s
            return (s[0], s[1], s[2], s[3], "ended", s[5], s[6], s[7], s[8],
                    s[9], s[10], s[11], s[12], s[13])

        actions = [
            ("a shared-workspace owner is the account to deactivate", lambda s: s),
            ("the account is also an ordinary member, not an owner", make_non_owner),
            ("a second administrator is appointed so this admin is not last", make_admin_with_successor),
            ("an active administrator deactivates the account", apply_deactivate),
            ("the deactivated human tries to sign in", login),
            ("a retained session cookie is presented after deactivation", use_session),
            ("a stale session identity tries to issue a new key", stale_issue_key),
            ("a reset request is made for the deactivated account", stale_reset),
            ("a stale invitation is accepted by the deactivated account", stale_invitation),
            ("the deactivated human's agent key authenticates", use_key),
            ("a claim completes on its own before deactivation", settle_claim),
            ("an administrator reactivates the account", reactivate),
            ("the reactivated human accepts a fresh invitation", reinvite),
        ]

        init = ("active", 1, 1, "live", "active", True, "active", True, False,
                True, False, False, frozenset(), frozenset())

        def inv(s):
            v = s[-1]
            if v:
                return False, f"account-deactivation invariant broken: {sorted(v)[0]}"
            (status, admins, sessions, key, claim, grant, membership, is_owner,
             former, was_owner, is_admin, revived, events, _) = s
            if admins <= 0:
                return False, "no active system administrator remains"
            if status == "deactivated":
                if sessions != 0:
                    return False, "a browser session survived deactivation"
                if key != "revoked":
                    return False, "an agent key survived deactivation"
                if claim not in ("released", "ended"):
                    return False, "an active claim survived deactivation"
                if grant or membership != "suspended":
                    return False, "shared authority survived deactivation"
                if is_owner or former != was_owner:
                    return False, "former ownership was not retained correctly"
                if "account_deactivated" not in events:
                    return False, "no deactivation event was recorded"
            if revived:
                if "account_reactivated" not in events:
                    return False, "no reactivation event was recorded"
                if membership == "suspended" and (is_owner or former != was_owner):
                    return False, "reactivation restored former ownership"
                if membership == "active" and (is_owner or former):
                    return False, "re-invitation restored former ownership"
                if membership == "suspended" and key != "revoked":
                    return False, "an old key was revived on reactivation"
            return True, ""

        result = bfs_check(
            "M22",
            "Account Deactivation and Reactivation (#38)",
            "Deactivation is one transaction that ends sessions, revokes every key and grant, releases claims, suspends memberships while retaining former ownership, and records an event; the last active administrator is refused; reactivation restores only the identity, never shared authority or old credentials, which return only through a fresh invitation and replacement keys",
            "safety",
            init,
            lambda s: [(label, action(s)) for label, action in actions],
            inv,
            [
                "apps/server/src/features/deactivation/service.ts",
                "apps/server/src/features/deactivation/rest.ts",
                "apps/server/src/features/accounts/service.ts",
                "apps/server/src/features/agents/service.ts",
                "apps/server/src/features/workspaces/service.ts",
                "apps/server/src/features/projects/service.ts",
                "apps/server/src/features/work-sessions/service.ts",
                "apps/server/src/features/transfers/service.ts",
                "apps/server/src/features/history/service.ts",
                "apps/server/src/db/schema.ts",
                "db/migrations/0027_account_deactivation_owner_guard.sql",
            ],
        )
        if result.status != "verified":
            return result

        # Sensitivity: run the same bounded explorer with every M22 guard flipped. A model
        # that still passes would prove nothing, so that case is reported as a failure.
        saved = dict(g)
        for key in [k for k in saved if k.startswith("m22_")]:
            g[key] = not saved[key]
        try:
            naive = bfs_check("M22-naive", result.model, result.property_name, result.kind,
                              init, lambda s: [(label, action(s)) for label, action in actions],
                              inv, result.files)
        finally:
            g.clear()
            g.update(saved)
        if naive.status == "verified":
            return CheckResult(
                "M22", result.model, result.property_name, result.kind, "violated",
                result.states_explored, result.transitions_explored,
                "model is not sensitive: flipping every extracted M22 guard left the invariant intact",
                ["flip every m22_* guard"], result.files,
            )
        return result

    return model_bfs()



def check_m23(facts: dict[str, Any]) -> CheckResult:
    """#42: the fallback policy matrix and the one-hour deadline branching.

    State: (project policy, issue override, DB clock, question status, needs_input,
    claim, follow-up, violations). The fixed model proves that only Manage can set a
    project policy or loosen an issue, that Contribute can tighten, that no agent key can
    authorize its own fallback or write policy, that the deadline branches to
    fallback_used (authorized fallback, Needs input cleared, claim kept while checking in)
    or paused (claim released, Needs input kept), that authorization is disclosed only on
    fallback_used, that a late answer is a follow-up, and that fallback never enlarges
    an agent's current access. Every extracted source guard is proven sensitive: flipping
    one makes the same explorer reach a named counterexample.
    """
    guards = {
        "contract": facts["m23_contract"],
        "schema": facts["m23_schema"],
        "project_manage": facts["m23_project_manage"],
        "issue_contribute": facts["m23_issue_contribute"],
        "tighten_only": facts["m23_tighten_only"],
        "no_agent": facts["m23_no_agent"],
        "effective": facts["m23_effective"],
        "lease_unclipped": facts["m23_lease_unclipped"],
        "reacquire_deadline": facts["m23_reacquire_deadline"],
        "freeze": facts["m23_freeze"],
        "branch": facts["m23_branch"],
        "db_time": facts["m23_db_time"],
        "authorized_only": facts["m23_authorized_only"],
        "follow_up": facts["m23_follow_up"],
        "no_enlarge": facts["m23_no_enlarge"],
        "activity": facts["m23_activity"],
        "problems": facts["m23_problems"],
    }
    init = ("require_human", None, "before", "open", True, "held", False, frozenset())
    files = [
        "apps/server/src/features/projects/service.ts",
        "apps/server/src/features/projects/rest.ts",
        "apps/server/src/features/inbox/service.ts",
        "apps/server/src/features/inbox/mcp.ts",
        "apps/server/src/features/work-sessions/service.ts",
        "packages/contract/src/projects.ts",
        "packages/contract/src/questions.ts",
        "packages/contract/src/mcp-tools.ts",
        "apps/server/src/db/schema.ts",
        "db/migrations/0028_fast_puck.sql",
    ]

    def verify(g: dict[str, bool]) -> CheckResult:
        def transitions(state):
            project, override, clock, qstatus, needs, claim, follow, violations = state
            out: list[tuple[str, Any]] = []

            def go(label, **changes):
                nxt = {
                    "project": project,
                    "override": override,
                    "clock": clock,
                    "qstatus": qstatus,
                    "needs": needs,
                    "claim": claim,
                    "follow": follow,
                }
                nxt.update(changes)
                out.append(
                    (
                        label,
                        (
                            nxt["project"],
                            nxt["override"],
                            nxt["clock"],
                            nxt["qstatus"],
                            nxt["needs"],
                            nxt["claim"],
                            nxt["follow"],
                            violations | changes.get("extra", frozenset()),
                        ),
                    )
                )

            def bad(*reasons):
                return frozenset(reasons)

            # Database time advances independently of any process.
            if clock == "before":
                go("one-hour response deadline passes in database time", clock="after")

            # Project policy: only a human with Manage. A contributor, reader, outsider
            # or agent key is refused; the violation only appears when the guard is gone.
            policy_guard = g["project_manage"] and g["no_agent"]
            for actor in ("manage", "contribute", "read", "outsider", "agent"):
                if actor == "manage":
                    if policy_guard:
                        go("Manage sets the project policy to fallback_allowed", project="fallback_allowed")
                    else:
                        go("Manage is wrongly refused the project policy (bug)", extra=bad("manage_policy_refused"))
                elif policy_guard:
                    go(f"{actor} is refused the project policy")
                else:
                    go(
                        f"{actor} sets the project policy without Manage (bug)",
                        project="fallback_allowed",
                        extra=bad("non_manage_project_policy"),
                    )

            # Issue override: Contribute may tighten; Manage may also loosen. Explicit
            # fallback_allowed and clearing a require_human override under a
            # fallback_allowed project are the two loosening shapes.
            for actor in ("manage", "contribute", "read", "outsider", "agent"):
                human = actor in ("manage", "contribute")
                for requested, label in (
                    ("require_human", "require_human override (tighten)"),
                    ("fallback_allowed", "explicit fallback_allowed override (loosen)"),
                    (None, "cleared override"),
                ):
                    before = override or project
                    after = requested or project
                    loosens = requested == "fallback_allowed" or (
                        after == "fallback_allowed" and before == "require_human"
                    )
                    role_allows = human and (not loosens or actor == "manage")
                    guards_allow = g["issue_contribute"] and g["no_agent"] and (
                        not loosens or g["tighten_only"]
                    )
                    if role_allows and guards_allow:
                        go(f"{actor} sets {label}", override=requested)
                    elif role_allows and not guards_allow:
                        go(f"{actor} is wrongly refused {label} (bug)", extra=bad("valid_override_refused"))
                    elif guards_allow:
                        go(f"{actor} is refused {label}")
                    else:
                        go(
                            f"{actor} sets {label} without authority (bug)",
                            override=requested,
                            extra=bad("unauthorized_override"),
                        )

            # A checking-in worker near the boundary keeps a full lease when the fallback
            # is authorized; clipping it would expire the claim one second after 1h.
            if qstatus == "open" and clock == "before" and project == "fallback_allowed":
                go(
                    "worker checks in near the 1h boundary under fallback_allowed",
                    extra=frozenset() if g["lease_unclipped"] else bad("lease_clipped_to_deadline"),
                )

            # An expired claim can reacquire after the deadline only because the deadline
            # evaluation first clears Needs input under fallback_allowed.
            if qstatus == "fallback_used" and clock == "after":
                go(
                    "an expired worker reacquires after the authorized deadline",
                    extra=frozenset()
                    if g["reacquire_deadline"]
                    else bad("reacquire_blocked_by_stale_needs_input"),
                )

            # Changing policy while a question is already past due freezes its outcome
            # first; without that it could be re-projected from fallback_used to paused.
            if qstatus == "open" and clock == "after":
                go(
                    "manager changes policy while a question is already past due",
                    extra=frozenset() if g["freeze"] else bad("due_question_reprojected"),
                )

            # The deadline reads the effective policy on the issue-locked transaction.
            if qstatus == "open" and clock == "after":
                effective = override or project
                if g["effective"] and effective == "fallback_allowed":
                    if g["branch"] and g["db_time"]:
                        go(
                            "deadline authorizes the proposed fallback, clears Needs input "
                            "and keeps a checking-in claim",
                            qstatus="fallback_used",
                            needs=False,
                        )
                    else:
                        go(
                            "deadline mishandles an authorized fallback (bug)",
                            qstatus="fallback_used",
                            needs=True,
                            claim="released",
                            extra=bad("fallback_mishandled"),
                        )
                elif g["effective"] and effective == "require_human":
                    if g["branch"] and g["db_time"]:
                        go(
                            "deadline pauses, releases the claim and keeps Needs input",
                            qstatus="paused",
                            needs=True,
                            claim="released",
                        )
                    else:
                        go(
                            "deadline pauses without releasing the claim (bug)",
                            qstatus="paused",
                            extra=bad("pause_without_release"),
                        )
                else:
                    go(
                        "deadline ignores the effective policy (bug)",
                        qstatus="fallback_used",
                        needs=False,
                        extra=bad("override_ignored"),
                    )

            # A human answer resolves an on-time or paused question exactly once.
            for actor in ("manage", "contribute"):
                if qstatus in ("open", "paused") and (
                    qstatus == "paused" or clock == "before" or not g["db_time"]
                ):
                    go(
                        f"{actor} answers an unresolved question",
                        qstatus="answered",
                        needs=False,
                        extra=frozenset() if g["db_time"] or clock == "before" else bad("answer_raced_deadline"),
                    )
                elif qstatus == "fallback_used":
                    if g["follow_up"]:
                        go(
                            "late human answer is a follow-up: status, Needs input and "
                            "the closed issue stay untouched",
                            follow=True,
                        )
                    else:
                        go(
                            "late answer reverses the fallback (bug)",
                            qstatus="answered",
                            needs=False,
                            extra=bad("answer_reversed_fallback"),
                        )
            # Agents (including sibling runs) cannot answer at all.
            go(
                "agent key tries to answer the question",
                extra=frozenset() if g["no_agent"] else bad("agent_answered"),
            )

            # The harness only sees the proposed fallback once it is authorized.
            if qstatus == "fallback_used":
                go(
                    "harness reads the authorized fallback from a fallback_used question",
                    extra=frozenset() if g["authorized_only"] else bad("fallback_not_authorized"),
                )
            if qstatus == "open":
                go(
                    "harness reads an open question's authorized fallback",
                    extra=frozenset() if g["authorized_only"] else bad("premature_fallback"),
                )

            # A fallback authorization never enlarges an agent's current project access.
            if project == "fallback_allowed" and qstatus == "fallback_used":
                go(
                    "a Read-ceiling agent attempts a fenced write after the fallback",
                    extra=frozenset() if g["no_enlarge"] else bad("fallback_enlarged_access"),
                )

            # Static source guards: absence is itself a reachable violation trace.
            if not g["contract"]:
                go("contract lacks the policy or fallback_used shape (bug)", extra=bad("no_fallback_contract"))
            if not g["schema"]:
                go("schema lacks the policy columns or CHECK constraints (bug)", extra=bad("no_policy_constraints"))
            if not g["activity"]:
                go("policy or fallback event is missing from history (bug)", extra=bad("policy_event_missing"))
            if not g["problems"]:
                go("policy route lacks its 400 Problem (bug)", extra=bad("missing_400_problem"))
            return out

        def invariant(state):
            project, override, clock, qstatus, needs, claim, follow, violations = state
            if violations:
                return False, "fallback policy invariant broken: " + sorted(violations)[0]
            if qstatus == "fallback_used" and needs:
                return False, "Needs input stayed set after an authorized fallback"
            if qstatus == "paused" and claim == "held":
                return False, "a paused issue still holds the claim"
            if qstatus == "answered" and needs:
                return False, "an answered issue is still Needs input"
            if follow and qstatus != "fallback_used":
                return False, "a follow-up reversed the fallback resolution"
            return True, ""

        return bfs_check(
            "M23",
            "Fallback Policy & Late Answers (#42)",
            "Only Manage sets policy or loosens, Contribute tightens, no agent self-authorizes, the 1h deadline branches to an authorized fallback or a paused claim, and a late answer is a follow-up",
            "safety",
            init,
            transitions,
            invariant,
            files,
        )

    fixed = verify(guards)
    if fixed.status != "verified":
        return fixed
    weak = []
    for key in guards:
        flipped = dict(guards)
        flipped[key] = False
        if verify(flipped).status == "verified":
            weak.append(key)
    if weak:
        return CheckResult(
            "M23",
            "Fallback Policy & Late Answers (#42)",
            "Sensitivity: every M23 source guard must matter",
            "safety",
            "violated",
            fixed.states_explored,
            fixed.transitions_explored,
            "Insensitive guards: " + ", ".join(weak),
            [],
            files,
        )
    return CheckResult(
        "M23",
        "Fallback Policy & Late Answers (#42)",
        "Only Manage sets policy or loosens, Contribute tightens, no agent self-authorizes, the 1h deadline branches to an authorized fallback or a paused claim, and a late answer is a follow-up",
        "safety",
        "verified",
        fixed.states_explored,
        fixed.transitions_explored,
        f"Verified across {fixed.states_explored} reachable states ({fixed.transitions_explored} transitions); "
        f"all {len(guards)} source guards proven sensitive by source mutation.",
        [],
        files,
    )



def check_m24(facts: dict[str, Any]) -> CheckResult:
    """#46: a shared-to-shared transfer is authorized by a source owner, accepted by a
    destination authority (or completed directly by one person), and rechecks that owner,
    destination authority, current ownership and no live DB-time work in one transaction.
    It removes the source grant, every source key's project scope and every still-pending
    offer, so a W1 -> W2 -> W1 round trip revives none of them. Access-change events carry
    the owning workspace, so a source's membership history never appears in the destination's
    project or workspace history. Every transition consults a source-extracted guard."""
    g = facts

    def bad(violations: frozenset[str], reason: str) -> frozenset[str]:
        return violations | {reason}

    def apply_transfer(state, destination: str):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state

        # One transaction, ownership lock first, guards before the project row and issues.
        if not g["m24_single_tx"]:
            v = bad(v, "accept_split_across_transactions")
        if not g["m24_lock_first"]:
            v = bad(v, "ownership_lock_not_first")
        if not g["m24_guard_order"]:
            v = bad(v, "workspace_guards_not_ordered_before_project")
        if not g["m24_issue_lock"]:
            v = bad(v, "issues_not_locked_before_active_work_check")
        if not g["m24_preserve_identity"]:
            v = bad(v, "authorship_rewritten_on_move")

        # Cleanup is what makes a return trip non-reviving.
        if not g["m24_grant_cleanup"]:
            v = bad(v, "source_grant_survived")
        else:
            grants = grants - {"old"}
        if not g["m24_key_cleanup"]:
            v = bad(v, "source_key_followed_project")
        else:
            keys = False
        if not g["m24_offer_cleanup"] or not g["m24_pending_offers_only"]:
            v = bad(v, "pending_offer_not_invalidated")
        else:
            offers = False
        if not g["m24_expire_lapsed"]:
            v = bad(v, "stale_active_session_moved")
        if not g["m24_revoke_siblings"]:
            v = bad(v, "sibling_authorization_left_pending")

        # Move, then rebuild destination access and its audit trail.
        pws = destination
        if not g["m24_grant_rebuild"]:
            v = bad(v, "destination_manage_grants_missing")
        else:
            grants = grants | {"dest"}
        if not g["m24_grant_events"]:
            v = bad(v, "destination_grant_events_missing")
        if not g["m24_receipt_events"]:
            v = bad(v, "destination_receipt_missing")
        if not g["m24_access_event_scope"]:
            v = bad(v, "access_events_not_workspace_scoped")
        # The new grant event must be scoped to the destination, never to the source.
        grant_scope = "dest" if g["m24_grant_event_workspace"] else "source"
        new_events = {(grant_scope, "grant"), ("source", "out"), ("dest", "receipt")}
        if not g["m24_history_filter"] and any(scope == "source" for scope, _ in events):
            v = bad(v, "source_access_history_leaked_to_dest")
        if not g["m24_history_project_filter"]:
            v = bad(v, "source_events_in_dest_project_history")
        events = events | new_events

        phase = "transferred" if destination == "W2" else "returned"
        return (phase, "accepted", owner, dest_ok, dest_member, pws, "none", keys,
                grants, offers, events, auth_live, v)

    def authorize(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase != "start":
            return state
        if not g["m24_shared_source"]:
            v = bad(v, "shared_source_authority_not_checked")
        if not owner:
            if not g["m24_recheck_shared_owner"]:
                v = bad(v, "authorized_without_shared_source_ownership")
            return state
        if not g["m24_two_party"]:
            v = bad(v, "two_party_authorization_required_destination_authority")
        if not g["m24_visibility"]:
            v = bad(v, "wrong_visibility_change_for_shared_source")
        if not g["m24_http_problems"]:
            v = bad(v, "validated_route_without_400_problem")
        if not g["m24_human_only"]:
            v = bad(v, "agent_key_can_authorize_transfer")
        if not dest_member and not g["m24_authorize_redaction"]:
            v = bad(v, "destination_owner_pii_leaked")
        return ("authorized", "pending", owner, dest_ok, dest_member, pws, claim,
                keys, grants, offers, events, True, v)

    def preview(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if not dest_member and not g["m24_dest_membership_preview"]:
            v = bad(v, "destination_enumerated_by_preview")
        return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    def receiver_preview(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase != "authorized" or auth != "pending":
            return state
        if not g["m24_receiver_preview"]:
            v = bad(v, "no_receiver_preview")
        if not dest_member or not dest_ok:
            if not g["m24_receiver_authority"]:
                v = bad(v, "unauthorized_receiver_saw_preview")
        return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    def same_workspace_probe(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase != "start":
            return state
        if not g["m24_same_workspace"]:
            v = bad(v, "same_workspace_transfer_allowed")
        return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    def lose_owner(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, False, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    def gain_dest(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, True, True, pws, claim, keys, grants,
                offers, events, auth_live, v)

    def lose_dest(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, False, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    def leave_dest(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, False, False, pws, claim, keys, grants,
                offers, events, auth_live, v)

    def claim(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, dest_ok, dest_member, pws, "live", keys,
                grants, offers, events, auth_live, v)

    def expire_claim(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, dest_ok, dest_member, pws, "expired", keys,
                grants, offers, events, auth_live, v)

    def expire_auth(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, False, v)

    def move_project(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return (phase, auth, owner, dest_ok, dest_member, "elsewhere", claim,
                keys, grants, offers, events, auth_live, v)

    def accept(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase != "authorized" or auth != "pending":
            return state
        if not auth_live:
            if not g["m24_db_time_expiry"]:
                return apply_transfer_expired(state)
            return state
        if not dest_member:
            if not g["m24_accept_membership"]:
                return apply_transfer_violation(state, "non_member_accepted_transfer")
            return state
        # Destination authority is gated before the source-owner recheck, so a stranger or
        # a member without Create projects never learns the authorizer lost ownership.
        if not dest_ok:
            if not g["m24_dest_authority"]:
                return apply_transfer_violation(state, "accepted_after_destination_authority_lost")
            return state
        if not owner:
            if not g["m24_recheck_shared_owner"]:
                return apply_transfer_violation(state, "accepted_after_source_owner_lost")
            return state
        if dest_ok and not g["m24_dest_authority"]:
            v = bad(v, "valid_destination_authority_refused")
        if pws != "W1":
            if not g["m24_recheck_workspace"]:
                return apply_transfer_violation(state, "accepted_after_workspace_changed")
            return state
        if claim == "live":
            if not (g["m24_active_work"] and g["m24_db_time_live"]):
                return apply_transfer_violation(state, "transferred_with_live_work")
            return state
        return apply_transfer(state, "W2")

    def apply_transfer_violation(state, reason: str):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return apply_transfer(
            (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
             offers, events, auth_live, bad(v, reason)),
            "W2",
        )

    def apply_transfer_expired(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        return apply_transfer(
            (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
             offers, events, auth_live, bad(v, "expired_authorization_accepted")),
            "W2",
        )

    def complete(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase != "start" or not owner:
            return state
        if not dest_member:
            if not g["m24_dest_membership_complete"]:
                v = bad(v, "complete_enumerated_destination")
            return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                    grants, offers, events, auth_live, v)
        if not dest_ok:
            return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                    grants, offers, events, auth_live, v)
        if not g["m24_dest_authority"]:
            v = bad(v, "direct_flow_denied_valid_authority")
        if pws != "W1":
            return state
        if claim == "live":
            if not (g["m24_active_work"] and g["m24_db_time_live"]):
                return apply_transfer_violation(state, "transferred_with_live_work")
            return state
        return apply_transfer(state, "W2")

    def transfer_back(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase != "transferred" or pws != "W2":
            return state
        if not owner:
            if not g["m24_recheck_shared_owner"]:
                v = bad(v, "returned_after_source_owner_lost")
            return state
        if claim == "live":
            if not (g["m24_active_work"] and g["m24_db_time_live"]):
                v = bad(v, "returned_with_live_work")
            return state
        return apply_transfer(state, "W1")

    def redeem_offer(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase not in ("transferred", "returned"):
            return state
        if offers:
            v = bad(v, "pending_offer_granted_after_move")
        return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    def project_history(state):
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, v) = state
        if phase not in ("transferred", "returned"):
            return state
        if not g["m24_history_project_filter"]:
            v = bad(v, "source_events_in_dest_project_history")
        if not g["m24_history_filter"] and any(scope == "source" for scope, _ in events):
            v = bad(v, "source_access_history_leaked_to_dest")
        return (phase, auth, owner, dest_ok, dest_member, pws, claim, keys,
                grants, offers, events, auth_live, v)

    actions = [
        ("the source owner previews the shared-to-shared move", preview),
        ("a transfer to the same workspace is probed", same_workspace_probe),
        ("a stranger previews the pending token", receiver_preview),
        ("the authorizing owner is demoted or removed", lose_owner),
        ("the destination grants Create projects", gain_dest),
        ("destination Create projects authority is withdrawn", lose_dest),
        ("the receiver leaves the destination", leave_dest),
        ("the source owner authorizes without destination authority", authorize),
        ("a worker claims an issue on the project", claim),
        ("the claim's lease lapses in database time", expire_claim),
        ("the authorization expires in database time", expire_auth),
        ("the project moves elsewhere before acceptance", move_project),
        ("the destination authority accepts", accept),
        ("one person with both authorities completes directly", complete),
        ("the project is transferred back to W1", transfer_back),
        ("the old pending offer is redeemed after the move", redeem_offer),
        ("the destination reads the project's history", project_history),
    ]

    init = ("start", "none", True, False, False, "W1", "none", True,
            frozenset({"old"}), True, frozenset({("source", "grant")}), True,
            frozenset())

    def next_states(state):
        return [(label, action(state)) for label, action in actions]

    def inv(state):
        v = state[-1]
        if v:
            return False, f"shared-transfer invariant broken: {sorted(v)[0]}"
        (phase, auth, owner, dest_ok, dest_member, pws, claim, keys, grants,
         offers, events, auth_live, _) = state
        if phase in ("transferred", "returned"):
            if keys:
                return False, "a W1 key still names the moved project"
            if "old" in grants:
                return False, "a W1 grant survived or revived after a move"
            if offers:
                return False, "a pending offer still names the moved project"
            if ("dest", "grant") not in events:
                return False, "the destination recorded no Manage grant event"
            if ("source", "out") not in events or ("dest", "receipt") not in events:
                return False, "both sides of the transfer were not recorded"
        return True, ""

    return bfs_check(
        "M24",
        "Shared-to-Shared Project Transfer (#46)",
        "A shared source owner authorizes (or one person completes) a move to another shared workspace; one transaction rechecks that owner, destination authority, current ownership and no live DB-time work, removes every W1 grant/key/pending offer so a round trip revives none, and keeps each workspace's access-change events strictly its own",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/transfers/service.ts",
            "apps/server/src/features/transfers/rest.ts",
            "packages/contract/src/transfers.ts",
            "apps/server/src/features/history/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0029_numerous_clint_barton.sql",
        ],
    )


def check_m25(facts: dict[str, Any]) -> CheckResult:
    """#43: ownership recovery of an ownerless shared workspace.

    State: (workspace kind, active owner present, actor active, actor is admin,
    actor membership/current and initial, actor project grant/current and initial,
    target self/existence/activity/membership, recovered, notified, events,
    violations). The model explores refusals (active owner, self-promotion,
    deactivated target, outsider, suspended non-former-owner, personal workspace,
    inactive or non-admin caller) alongside both eligible promotions (an active
    member after another owner's deactivation, and a reactivated former sole owner).
    Each source guard is extracted from the service, REST, contract, history and
    migration; flipping any single one makes the same explorer reach a named
    counterexample, which is the sensitivity proof.
    """
    g = facts
    files = [
        "apps/server/src/features/ownership/service.ts",
        "apps/server/src/features/ownership/rest.ts",
        "packages/contract/src/ownership.ts",
        "apps/server/src/features/history/service.ts",
        "apps/server/src/db/schema.ts",
        "db/migrations/0030_neat_tusk.sql",
    ]

    def bad(violations: frozenset[str], reason: str) -> frozenset[str]:
        return violations | {reason}

    structural = [
        ("m25_one_tx", "recovery_split_across_transactions"),
        ("m25_lock_first", "ownership_lock_not_first"),
        ("m25_admin_recheck", "admin_recheck_missing"),
        ("m25_shared_only", "personal_workspace_recoverable"),
        ("m25_guard_bump", "ownership_guard_not_bumped"),
        ("m25_self_guard", "self_promotion_guard_missing"),
        ("m25_active_owner_guard", "active_owner_guard_missing"),
        ("m25_target_active_guard", "deactivated_target_guard_missing"),
        ("m25_membership_guard", "eligibility_guard_missing"),
        ("m25_promote", "promotion_not_atomic"),
        ("m25_events", "events_not_recorded"),
        ("m25_history", "recovery_not_visible_in_history"),
        ("m25_notify_after_commit", "notification_missing_or_before_commit"),
        ("m25_no_admin_grant", "administrator_gained_membership_or_project"),
        ("m25_no_key_revival", "old_agent_keys_revived"),
        ("m25_human_only", "agent_key_can_recover"),
        ("m25_http_problems", "undeclared_problem_response"),
    ]

    def recover(state):
        (wsk, has_owner, aa, aadmin, am, ami, ag, agi, tself, texists, tactive,
         tmem, recovered, notified, events, v) = state
        for guard, reason in structural:
            if not g[guard]:
                v = bad(v, reason)
        if recovered:
            return state[:-1] + (v,)
        # Every refusal leaves the workspace untouched; the guards above fail the
        # property if a refusal were not enforced or a transition were torn.
        if not (aa and aadmin):
            return state[:-1] + (v,)
        if wsk != "shared" or tself or has_owner:
            return state[:-1] + (v,)
        if not texists or not tactive or tmem not in ("active", "suspended_former"):
            return state[:-1] + (v,)
        # One promotion, both audit trails, notification after commit, and no new
        # administrator membership or project grant.
        return (wsk, has_owner, aa, aadmin, am, ami, ag, agi, tself, texists,
                tactive, tmem, True, True, events | {"workspace_event", "installation_event"}, v)

    def read_directory(state):
        v = state[-1]
        if not g["m25_directory_scope"]:
            v = bad(v, "directory_leaked_project_content")
        if not g["m25_admin_recheck"]:
            v = bad(v, "non_admin_directory_access")
        return state[:-1] + (v,)

    def make_personal(state):
        return ("personal",) + state[1:]

    def deactivate_sole_owner(state):
        if state[11] not in ("active", "suspended_former"):
            return state
        return state[:1] + (False,) + state[2:11] + ("suspended_former",) + state[12:]

    def other_owner_deactivated(state):
        if state[11] != "active":
            return state
        return state[:1] + (False,) + state[2:]

    def make_outsider(state):
        return state[:11] + ("none",) + state[12:]

    def make_suspended_other(state):
        return state[:11] + ("suspended_other",) + state[12:]

    def deactivate_target(state):
        return state[:10] + (False,) + state[11:]

    def make_self(state):
        return state[:8] + (True,) + state[9:]

    def remove_target(state):
        return state[:9] + (False,) + state[10:]

    def deactivate_actor(state):
        return state[:2] + (False,) + state[3:]

    def remove_admin_role(state):
        return state[:3] + (False,) + state[4:]

    def give_actor_membership(state):
        return state[:4] + (True, True) + state[6:]

    def give_actor_grant(state):
        return state[:6] + (True, True) + state[8:]

    # Setup actions describe the world before recovery; replaying one afterwards would
    # manufacture an impossible post-recovery state (e.g. turning the workspace personal
    # after it was promoted), so they are inert once recovery has committed.
    def setup(action):
        return lambda s: s if s[12] else action(s)

    actions = [
        ("the workspace is personal rather than shared", setup(make_personal)),
        ("the sole owner is deactivated, retaining a suspended former owner", setup(deactivate_sole_owner)),
        ("a different owner is deactivated while the target stays an active member", setup(other_owner_deactivated)),
        ("the target is an outsider with no membership row", setup(make_outsider)),
        ("the target's suspended membership never held ownership", setup(make_suspended_other)),
        ("the target is still deactivated", setup(deactivate_target)),
        ("the target is the acting administrator", setup(make_self)),
        ("the target account does not exist", setup(remove_target)),
        ("the administrator account is deactivated", setup(deactivate_actor)),
        ("the caller is not an administrator", setup(remove_admin_role)),
        ("the administrator is an active member of the workspace", setup(give_actor_membership)),
        ("the administrator already holds a project grant", setup(give_actor_grant)),
        ("an administrator reads the installation directory", read_directory),
        ("an administrator recovers ownership", recover),
    ]

    # shared, active owner, active admin caller, not a member, no grant,
    # target is an existing, active, ordinary member, nothing recovered yet.
    init = ("shared", True, True, True, False, False, False, False, False, True,
            True, "active", False, False, frozenset(), frozenset())

    def inv(state):
        v = state[-1]
        if v:
            return False, f"ownership-recovery invariant broken: {sorted(v)[0]}"
        (wsk, has_owner, aa, aadmin, am, ami, ag, agi, tself, texists, tactive,
         tmem, recovered, notified, events, _) = state
        if recovered:
            if wsk != "shared":
                return False, "a personal workspace was recovered"
            if has_owner:
                return False, "recovery happened while an active owner existed"
            if tself:
                return False, "the administrator promoted themselves"
            if not (aa and aadmin):
                return False, "an inactive or non-admin caller recovered ownership"
            if not (texists and tactive):
                return False, "a missing or still-deactivated target was promoted"
            if tmem not in ("active", "suspended_former"):
                return False, "an ineligible target was promoted"
            if "workspace_event" not in events or "installation_event" not in events:
                return False, "both workspace and installation events were not recorded"
            if not notified:
                return False, "members were not notified"
            if am != ami or ag != agi:
                return False, "recovery changed the administrator's membership or project access"
        return True, ""

    def run(check_id: str) -> CheckResult:
        return bfs_check(
            check_id,
            "Ownership Recovery (#43)",
            "Only an active system administrator may read a minimal shared-workspace directory and promote an eligible active member or reactivated former sole owner of an ownerless shared workspace; recovery is one transaction that never lets the administrator promote themselves, gain membership or project access, or revive old keys, and it records and notifies",
            "safety",
            init,
            lambda s: [(label, action(s)) for label, action in actions],
            inv,
            files,
        )

    result = run("M25")
    if result.status != "verified":
        return result

    # Sensitivity: each extracted guard is flipped on its own. If any flip still passes,
    # the model proves nothing and is reported as a failure.
    for guard in [key for key in g if key.startswith("m25_")]:
        saved = g[guard]
        g[guard] = not saved
        try:
            naive = run(f"M25-naive-{guard}")
        finally:
            g[guard] = saved
        if naive.status == "verified":
            return CheckResult(
                "M25", result.model, result.property_name, result.kind, "violated",
                result.states_explored, result.transitions_explored,
                f"model is not sensitive: flipping {guard} left the invariant intact",
                [f"flip {guard}"], files,
            )
    guard_count = len([key for key in g if key.startswith("m25_")])
    return CheckResult(
        "M25", result.model, result.property_name, result.kind, "verified",
        result.states_explored, result.transitions_explored,
        f"{result.summary}; all {guard_count} source guards proven sensitive by single-guard mutation",
        [], files,
    )


def check_m26(facts: dict[str, Any]) -> CheckResult:
    """#82: human stop requests on active work sessions.
    State: (lease_live, stop_requested, activity_count, caller_deactivated, violations).
    """
    g = {k: facts[k] for k in facts if k.startswith("m26_")}

    def bad(v, reason: str):
        return v | {reason}

    def human_stop(state):
        live, stopped, acts, deact, v = state
        if deact:
            if not (g["m26_lock_order"] and g["m26_non_enum"]):
                v = bad(v, "deactivated_human_requested_stop")
            return (live, stopped, acts, deact, v)
        if not live:
            if not g["m26_db_time_write"]:
                return (live, True, acts + 1, deact, bad(v, "stopped_expired_session"))
            return state
        if stopped:
            if not g["m26_idempotent"]:
                return (live, True, acts + 1, deact, bad(v, "duplicate_stop_activity"))
            return state
        if not g["m26_activity_atomic"] or not g["m26_schema_check"]:
            v = bad(v, "non_atomic_stop_signal")
        return (live, True, acts + 1, deact, v)

    def agent_stop(state):
        live, stopped, acts, deact, v = state
        if not g["m26_human_only"]:
            v = bad(v, "agent_requested_stop")
        return (live, stopped, acts, deact, v)

    def lease_expires(state):
        live, stopped, acts, deact, v = state
        return (False, stopped, acts, deact, v)

    def deactivate_caller(state):
        live, stopped, acts, deact, v = state
        return (live, stopped, acts, True, v)

    actions = [
        ("human requests stop on active session", human_stop),
        ("agent key tries to request stop", agent_stop),
        ("five-minute lease expires in DB time", lease_expires),
        ("human caller is deactivated", deactivate_caller),
    ]
    init = (True, False, 0, False, frozenset())

    def inv(state):
        live, stopped, acts, deact, v = state
        if v:
            return False, f"human stop invariant broken: {sorted(v)[0]}"
        if acts > 1:
            return False, "repeated stop request wrote duplicate activity"
        if stopped and acts == 0:
            return False, "stop signal set without activity record"
        return True, ""

    return bfs_check(
        "M26",
        "Human Stop Requests on Active Work Sessions (#82)",
        "Only active Contribute/Manage humans may request a stop; M22 lock order and 404 non-enumeration protect deactivated/non-member callers; repeated stops are idempotent with one atomic activity event; DB-time expiry rejects stale stops",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/work-sessions/rest.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0031_next_masked_marvel.sql",
        ],
    )


def check_m27(facts: dict[str, Any]) -> CheckResult:
    """#86: acyclic issue dependencies and ready-work exclusion.
    State: (edges_frozenset, blocker_closed, violations) over 4 issues {A, B, C, D}.
    """
    g = {k: facts[k] for k in facts if k.startswith("m27_")}

    def bad(v, reason: str):
        return v | {reason}

    def has_cycle(edges):
        for start in ("A", "B", "C", "D"):
            seen = set()
            stack = [b for a, b in edges if a == start]
            while stack:
                node = stack.pop()
                if node == start:
                    return True
                if node not in seen:
                    seen.add(node)
                    stack.extend(b for a, b in edges if a == node)
        return False

    def add_edge(src, dst):
        def fn(state):
            edges, closed, v = state
            if src == dst:
                if not g["m27_no_self_link"]:
                    v = bad(v, "self_dependency_allowed")
                return (edges, closed, v)
            if (src, dst) in edges:
                if not g["m27_idempotent"]:
                    v = bad(v, "duplicate_edge_activity")
                return (edges, closed, v)
            if not g["m27_lock_order"]:
                v = bad(v, "abba_deadlock_issues_before_projects")
            if not g["m27_same_project"]:
                v = bad(v, "cross_project_edge_allowed")
            cand = edges | {(src, dst)}
            if has_cycle(cand):
                if not (g["m27_cycle_bfs"] and g["m27_project_lock"]):
                    return (cand, closed, bad(v, "cycle_committed"))
                return (edges, closed, v)
            return (cand, closed, v)

        return fn

    def check_ready(state):
        edges, closed, v = state
        if ("A", "B") in edges and not closed and not g["m27_ready_excludes"]:
            v = bad(v, "blocked_issue_offered_as_ready")
        return (edges, closed, v)

    def close_b(state):
        edges, closed, v = state
        return (edges, True, v)

    actions = [
        ("add A blocked_by A (self-link)", add_edge("A", "A")),
        ("add A blocked_by B", add_edge("A", "B")),
        ("add B blocked_by C", add_edge("B", "C")),
        ("add C blocked_by D", add_edge("C", "D")),
        ("add D blocked_by A (4-node cycle)", add_edge("D", "A")),
        ("close blocker B", close_b),
        ("poll list_ready_work", check_ready),
    ]
    init = (frozenset(), False, frozenset())

    def inv(state):
        edges, closed, v = state
        if v:
            return False, f"issue dependency invariant broken: {sorted(v)[0]}"
        if has_cycle(edges):
            return False, "dependency graph contains a cycle"
        return True, ""

    return bfs_check(
        "M27",
        "Acyclic Issue Dependencies & Ready-Work Exclusion (#86)",
        "Self-links, cross-project links, and cycles (including concurrent 4-node races under project-level FOR UPDATE in global projects->issues lock order) are rejected; list_ready_work omits issues with any open blocker",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0031_next_masked_marvel.sql",
        ],
    )


def check_m28(facts: dict[str, Any]) -> CheckResult:
    """#83: ephemeral session activities and deactivation-safe reads.
    State: (lease_live, activities_count, caller_deactivated, violations).
    """
    g = {k: facts[k] for k in facts if k.startswith("m28_")}

    def bad(v, reason: str):
        return v | {reason}

    def append_activity(state):
        live, count, deact, v = state
        if not live:
            if not g["m28_live_gate"]:
                return (live, min(2, count + 1), deact, bad(v, "appended_to_expired_session"))
            return state
        if not (g["m28_no_lease_mutation"] and g["m28_detail_bound"] and g["m28_schema_check"]):
            v = bad(v, "activity_write_guard_missing")
        return (live, min(2, count + 1), deact, v)

    def read_activities(state):
        live, count, deact, v = state
        if deact and not (g["m28_read_deactivation"] and g["m28_read_non_enum"]):
            v = bad(v, "deactivated_caller_read_activities")
        return (live, count, deact, v)

    def expire_lease(state):
        live, count, deact, v = state
        return (False, count, deact, v)

    def deactivate(state):
        live, count, deact, v = state
        return (live, count, True, v)

    actions = [
        ("agent appends session activity", append_activity),
        ("caller lists session activities", read_activities),
        ("lease expires in DB time (trail preserved)", expire_lease),
        ("caller is deactivated", deactivate),
    ]
    init = (True, 0, False, frozenset())

    def inv(state):
        live, count, deact, v = state
        if v:
            return False, f"session activity invariant broken: {sorted(v)[0]}"
        return True, ""

    return bfs_check(
        "M28",
        "Ephemeral Session Activities & Deactivation-Safe Reads (#83)",
        "Only the live session holder appends bounded activities without mutating leases or comments; trails survive expiry; deactivated or unrelated callers get 404 on read-only listing",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/work-sessions/service.ts",
            "packages/contract/src/sessions.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0031_next_masked_marvel.sql",
        ],
    )


def check_m29(facts: dict[str, Any]) -> CheckResult:
    """#84: assignment is a pull-queue hint; the claim stays authoritative.
    State: (assignee, claim_holder, violations). Assignee is one of none, human, A, B,
    invalid; a claim holder is None, A or B.
    """
    g = {k: facts[k] for k in facts if k.startswith("m29_")}

    def bad(v, reason: str):
        return v | {reason}

    def assign(target: str):
        def step(state):
            assignee, holder, v = state
            if not (g["m29_db_check"] and g["m29_contract_surface"]):
                v = bad(v, "assignee_not_representable")
            if target == "invalid":
                if g["m29_assignee_validation"]:
                    # The validated service refuses the write, so no state changes.
                    return state
                v = bad(v, "invalid_assignee_committed")
            return (target, holder, v)

        return step

    def reserved(assignee: str, agent: str) -> bool:
        return assignee == "human" or (assignee in ("A", "B") and assignee != agent)

    def claim(agent: str):
        def step(state):
            assignee, holder, v = state
            if reserved(assignee, agent):
                if not g["m29_strict_claim"]:
                    return (assignee, agent, bad(v, "reserved_issue_claimed"))
                return state
            # The one-active-session-per-issue index and idempotent same-run retry are
            # M17's property; here the only new decision is the assignee reservation.
            return (assignee, agent, v)

        return step

    def reacquire(agent: str):
        def step(state):
            assignee, holder, v = state
            if reserved(assignee, agent) and not g["m29_strict_claim"]:
                v = bad(v, "reserved_issue_reacquired")
            return (assignee, holder, v)

        return step

    def ready(agent: str):
        def step(state):
            assignee, holder, v = state
            if not g["m29_ready_filter"] and reserved(assignee, agent):
                # Without the filter the listing would offer work reserved for a human
                # or a sibling agent, which the strict claim policy would only refuse.
                v = bad(v, "reserved_work_offered")
            return (assignee, holder, v)

        return step

    def assign_after_deactivation(target: str):
        def step(state):
            assignee, holder, v = state
            if not (g["m29_lock_order"] and g["m29_assignee_validation"]):
                # Without the M22 lock order a racing write can commit an assignment
                # against an identity that deactivation has just suspended.
                return (target, holder, bad(v, "stale_assignee_after_deactivation"))
            return state

        return step

    def transfer_racing_assignment(state):
        assignee, holder, v = state
        if not g["m29_workspace_recheck"]:
            # The issue moved to another workspace after the precheck read; without the
            # recheck the source-workspace assignee would be committed onto it.
            v = bad(v, "cross_workspace_assignee")
        return (assignee, holder, v)

    actions = [
        ("assign to a human", assign("human")),
        ("assign to agent A", assign("A")),
        ("assign to agent B", assign("B")),
        ("clear the assignee", assign("none")),
        ("assign an unregistered identity", assign("invalid")),
        ("agent A claims", claim("A")),
        ("agent B claims", claim("B")),
        ("agent A reacquires after expiry", reacquire("A")),
        ("agent B reacquires after expiry", reacquire("B")),
        ("agent A lists ready work", ready("A")),
        ("agent B lists ready work", ready("B")),
        ("assign racing deactivation", assign_after_deactivation("A")),
        ("project transfer racing assignment", transfer_racing_assignment),
    ]
    init = ("none", None, frozenset())

    def inv(state):
        _, _, v = state
        if v:
            return False, f"assignment invariant broken: {sorted(v)[0]}"
        return True, ""

    return bfs_check(
        "M29",
        "Board Assignment & Strict Claims (#84)",
        "Assignment is a validated pull-queue hint: agents claim only unassigned or self-assigned work, ready work hides work reserved for others, and the assignee pair stays integral under deactivation races",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0031_next_masked_marvel.sql",
            "packages/contract/src/projects.ts",
            "packages/contract/src/sessions.ts",
        ],
    )


def check_m30(facts: dict[str, bool]) -> CheckResult:
    g = {
        "m30_six_states": facts["m30_six_states"],
        "m30_claim_to_in_progress": facts["m30_claim_to_in_progress"],
        "m30_revert_on_end": facts["m30_revert_on_end"],
        "m30_pause_and_lapsed_answer_revert": facts["m30_pause_and_lapsed_answer_revert"],
        "m30_completion_outcomes": facts["m30_completion_outcomes"],
    }

    def bad(v: frozenset[str], name: str) -> frozenset[str]:
        return v | {name}

    # State: (status, session_state, needs_input, closed_at, violations)
    # session_state: "none" | "active" | "lapsed"
    init = ("backlog", "none", False, False, frozenset())

    def queue_todo(state):
        status, sess, ni, closed, v = state
        if status == "backlog" and sess == "none" and not ni:
            return ("todo", sess, ni, False, v)
        return state

    def claim(state):
        status, sess, ni, closed, v = state
        if status != "todo":
            if not g["m30_claim_to_in_progress"]:
                return ("in_progress", "active", ni, closed, bad(v, "non_todo_claimed"))
            return state
        if sess == "none" and not ni:
            next_status = "in_progress" if g["m30_claim_to_in_progress"] else "todo"
            return (next_status, "active", ni, False, v)
        return state

    def lease_lapses(state):
        status, sess, ni, closed, v = state
        if sess == "active":
            return (status, "lapsed", ni, closed, v)
        return state

    def release_or_poll_ready(state):
        status, sess, ni, closed, v = state
        if sess in ("active", "lapsed"):
            next_status = "todo" if (status == "in_progress" and g["m30_revert_on_end"]) else status
            return (next_status, "none", ni, closed, v)
        return state

    def ask_question(state):
        status, sess, ni, closed, v = state
        if sess == "active" and status == "in_progress" and not ni:
            return (status, sess, True, closed, v)
        return state

    def pause_at_1h_deadline(state):
        status, sess, ni, closed, v = state
        if ni and sess in ("active", "lapsed"):
            next_status = (
                "todo"
                if (status == "in_progress" and g["m30_pause_and_lapsed_answer_revert"])
                else status
            )
            return (next_status, "none", True, closed, v)
        return state

    def human_answers(state):
        status, sess, ni, closed, v = state
        if ni:
            if sess in ("none", "lapsed"):
                next_status = (
                    "todo"
                    if (status == "in_progress" and g["m30_pause_and_lapsed_answer_revert"])
                    else status
                )
                return (next_status, "none", False, closed, v)
            return (status, "active", False, closed, v)
        return state

    def complete_review(state):
        status, sess, ni, closed, v = state
        if sess == "active" and status == "in_progress" and not ni:
            if not g["m30_completion_outcomes"]:
                return ("done", "none", False, True, bad(v, "handoff_skipped_review"))
            return ("review", "none", False, False, v)
        return state

    def complete_done(state):
        status, sess, ni, closed, v = state
        if sess == "active" and status == "in_progress" and not ni:
            next_closed = True if g["m30_six_states"] else False
            return ("done", "none", False, next_closed, v)
        return state

    actions = [
        ("human moves backlog to todo", queue_todo),
        ("agent claims issue", claim),
        ("five-minute lease lapses in DB time", lease_lapses),
        ("release or poll readyWork materializes expiry", release_or_poll_ready),
        ("agent asks question", ask_question),
        ("one-hour require_human deadline pauses question", pause_at_1h_deadline),
        ("human answers question", human_answers),
        ("agent completes with default review handoff", complete_review),
        ("agent completes directly to done", complete_done),
    ]

    def inv(state):
        status, sess, ni, closed, v = state
        if v:
            return False, f"workflow invariant broken: {sorted(v)[0]}"
        if (status in ("done", "cancelled")) != closed:
            return False, "workflow invariant broken: closed_at_mismatch"
        if status == "in_progress" and sess == "none" and not ni:
            return False, "workflow invariant broken: stranded_in_progress"
        if sess == "active" and status != "in_progress":
            return False, "workflow invariant broken: active_session_not_in_progress"
        return True, ""

    return bfs_check(
        "M30",
        "Six-State Issue Workflow & Session Transitions (#94)",
        "Issues follow the six-state workflow with derived needs_input, claim/release/expiry/pause/answer keep todo<->in_progress synchronized with no stranded in_progress state, and closed_at matches terminal states",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/inbox/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0036_tan_firebrand.sql",
            "packages/contract/src/projects.ts",
            "packages/contract/src/sessions.ts",
        ],
    )


def check_m31(facts: dict[str, bool]) -> CheckResult:
    g = {
        "m31_no_self_parent": facts["m31_no_self_parent"],
        "m31_same_project_parent": facts["m31_same_project_parent"],
        "m31_depth_one": facts["m31_depth_one"],
        "m31_trigger_lock_order": facts["m31_trigger_lock_order"],
        "m31_label_same_project": facts["m31_label_same_project"],
        "m31_label_schema_guards": facts["m31_label_schema_guards"],
    }

    # Issues i1 (p1), i2 (p1), i3 (p2); label L1 (p1).
    # State: (p_i1, p_i2, p_i3, l1_on_i3, violations)
    init = (None, None, None, False, frozenset())

    def set_parent(issue: str, parent: str, same_proj: bool):
        def step(state):
            p1, p2, p3, l1_i3, v = state
            parents = {"i1": p1, "i2": p2, "i3": p3}
            if issue == parent:
                if not g["m31_no_self_parent"]:
                    parents[issue] = parent
                    return (parents["i1"], parents["i2"], parents["i3"], l1_i3, v | {"self_parent"})
                return state
            if not same_proj:
                if not g["m31_same_project_parent"]:
                    parents[issue] = parent
                    return (parents["i1"], parents["i2"], parents["i3"], l1_i3, v | {"cross_project_parent"})
                return state
            has_child = any(p == issue for p in parents.values())
            parent_is_subtask = parents[parent] is not None
            if (has_child or parent_is_subtask) and not g["m31_depth_one"]:
                parents[issue] = parent
                return (parents["i1"], parents["i2"], parents["i3"], l1_i3, v | {"depth_exceeded"})
            if has_child or parent_is_subtask:
                return state
            if not g["m31_trigger_lock_order"]:
                return (p1, p2, p3, l1_i3, v | {"concurrent_depth_race"})
            parents[issue] = parent
            return (parents["i1"], parents["i2"], parents["i3"], l1_i3, v)
        return step

    def attach_cross_label(state):
        p1, p2, p3, l1_i3, v = state
        if not g["m31_label_same_project"]:
            return (p1, p2, p3, True, v | {"cross_project_label"})
        if not g["m31_label_schema_guards"]:
            return (p1, p2, p3, l1_i3, v | {"label_schema_weakened"})
        return state

    actions = [
        ("i1 self-parent", set_parent("i1", "i1", True)),
        ("i2 becomes subtask of i1 (same project)", set_parent("i2", "i1", True)),
        ("i1 becomes subtask of i2 (parent becomes subtask)", set_parent("i1", "i2", True)),
        ("i3 becomes subtask of i1 (cross project)", set_parent("i3", "i1", False)),
        ("attach p1 label to p2 issue i3", attach_cross_label),
    ]

    def inv(state):
        p1, p2, p3, l1_i3, v = state
        if v:
            return False, f"labels/subtasks invariant broken: {sorted(v)[0]}"
        if l1_i3:
            return False, "labels/subtasks invariant broken: cross_project_label"
        if p3 is not None:
            return False, "labels/subtasks invariant broken: cross_project_parent"
        parents = {"i1": p1, "i2": p2, "i3": p3}
        for child, par in parents.items():
            if par == child:
                return False, "labels/subtasks invariant broken: self_parent"
            if par is not None and parents.get(par) is not None:
                return False, "labels/subtasks invariant broken: depth_exceeded"
        return True, ""

    return bfs_check(
        "M31",
        "Project-Scoped Labels & One-Level Subtasks (#97)",
        "Subtasks stay strictly one level deep in the same project with no self-parent and lock-ordered trigger checks, and labels attach only within their own project under case-insensitive unique name and hex color constraints",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0038_subtask_and_label_invariants.sql",
        ],
    )


def check_m32(facts: dict[str, bool]) -> CheckResult:
    g = {
        "m32_human_only_delete": facts["m32_human_only_delete"],
        "m32_active_session_guard": facts["m32_active_session_guard"],
        "m32_manage_restore_db_window": facts["m32_manage_restore_db_window"],
        "m32_scrub_preserves_tombstone": facts["m32_scrub_preserves_tombstone"],
        "m32_schema_and_read_exclusion": facts["m32_schema_and_read_exclusion"],
    }

    # State: (lifecycle, has_session, ready_visible, row_exists, content_present, violations)
    # lifecycle: "live" | "trashed_fresh" | "trashed_expired" | "purged"
    init = ("live", True, False, True, True, frozenset())

    def end_session(state):
        lc, sess, ready, exists, content, v = state
        if lc == "live" and sess:
            return ("live", False, True, exists, content, v)
        return state

    def agent_delete(state):
        lc, sess, ready, exists, content, v = state
        if lc == "live" and not g["m32_human_only_delete"]:
            return ("trashed_fresh", False, False, exists, content, v | {"agent_deleted_issue"})
        return state

    def human_delete(state):
        lc, sess, ready, exists, content, v = state
        if lc != "live":
            return state
        if sess:
            if not g["m32_active_session_guard"]:
                return ("trashed_fresh", True, False, exists, content, v | {"deleted_with_active_session"})
            return state
        next_ready = False if g["m32_schema_and_read_exclusion"] else True
        return ("trashed_fresh", False, next_ready, exists, content, v)

    def advance_30_days(state):
        lc, sess, ready, exists, content, v = state
        if lc == "trashed_fresh":
            return ("trashed_expired", sess, ready, exists, content, v)
        return state

    def manage_restore(state):
        lc, sess, ready, exists, content, v = state
        if lc == "trashed_fresh":
            return ("live", False, True, exists, content, v)
        if lc in ("trashed_expired", "purged"):
            if not g["m32_manage_restore_db_window"]:
                return ("live", False, True, exists, content, v | {"restored_past_30d_or_purged"})
            return state
        return state

    def purge_sweep(state):
        lc, sess, ready, exists, content, v = state
        if lc == "trashed_expired":
            if not g["m32_scrub_preserves_tombstone"]:
                return ("purged", False, False, False, False, v | {"hard_deleted_or_unscrubbed"})
            return ("purged", False, False, True, False, v)
        return state

    actions = [
        ("active work session ends", end_session),
        ("agent attempts deleteIssue", agent_delete),
        ("human Contribute attempts deleteIssue", human_delete),
        ("30 days pass in DB time", advance_30_days),
        ("Project manager attempts restoreIssue", manage_restore),
        ("purgeExpiredTrash sweep runs", purge_sweep),
    ]

    def inv(state):
        lc, sess, ready, exists, content, v = state
        if v:
            return False, f"trash invariant broken: {sorted(v)[0]}"
        if not exists:
            return False, "trash invariant broken: tombstone_row_hard_deleted"
        if lc != "live" and ready:
            return False, "trash invariant broken: trashed_issue_in_ready_work"
        if lc == "purged" and content:
            return False, "trash invariant broken: purged_content_not_scrubbed"
        return True, ""

    return bfs_check(
        "M32",
        "Soft-Delete Trash, Restore & 30-Day Tombstone Scrubbing (#98)",
        "Only humans may soft-delete unclaimed issues; soft-deleted issues leave ready work; Project managers restore only within 30 days in DB time; 30-day scrub clears content in place while retaining the tombstoned issue row",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0039_cooing_alex_wilder.sql",
        ],
    )


def check_m33(facts: dict[str, bool]) -> CheckResult:
    g = {
        "m33_human_session_only": facts["m33_human_session_only"],
        "m33_deactivated_refused": facts["m33_deactivated_refused"],
        "m33_live_membership_and_ceiling": facts["m33_live_membership_and_ceiling"],
        "m33_assigned_and_session_filters": facts["m33_assigned_and_session_filters"],
        "m33_questions_db_time_contribute": facts["m33_questions_db_time_contribute"],
    }

    # State: (caller_active, member_active, grant, issue_open, session_live, q_open, violations)
    init = (True, True, "contribute", True, True, True, frozenset())

    def probe_agent(state):
        ca, ma, gr, io, sl, qo, v = state
        if not g["m33_human_session_only"]:
            return (ca, ma, gr, io, sl, qo, v | {"agent_read_my_work"})
        return state

    def deactivate(state):
        ca, ma, gr, io, sl, qo, v = state
        return (False, ma, gr, io, sl, qo, v)

    def suspend_member(state):
        ca, ma, gr, io, sl, qo, v = state
        return (ca, False, gr, io, sl, qo, v)

    def downgrade_read(state):
        ca, ma, gr, io, sl, qo, v = state
        return (ca, ma, "read", io, sl, qo, v)

    def close_or_trash_issue(state):
        ca, ma, gr, io, sl, qo, v = state
        return (ca, ma, gr, False, False, False, v)

    def query_my_work(state):
        ca, ma, gr, io, sl, qo, v = state
        if not ca and not g["m33_deactivated_refused"]:
            return (ca, ma, gr, io, sl, qo, v | {"deactivated_caller_served"})
        if not ma and not g["m33_live_membership_and_ceiling"]:
            return (ca, ma, gr, io, sl, qo, v | {"suspended_member_leaked"})
        if not io and not g["m33_assigned_and_session_filters"]:
            return (ca, ma, gr, io, sl, qo, v | {"terminal_or_trashed_leaked"})
        if gr == "read" and qo and not g["m33_questions_db_time_contribute"]:
            return (ca, ma, gr, io, sl, qo, v | {"reader_saw_actionable_question"})
        return state

    actions = [
        ("agent key probes /api/my-work", probe_agent),
        ("human account deactivated", deactivate),
        ("workspace membership suspended", suspend_member),
        ("project grant downgraded to Read", downgrade_read),
        ("issue closed or moved to Trash", close_or_trash_issue),
        ("caller queries /api/my-work", query_my_work),
    ]

    def inv(state):
        v = state[-1]
        if v:
            return False, f"my-work invariant broken: {sorted(v)[0]}"
        return True, ""

    return bfs_check(
        "M33",
        "Cross-Workspace My Work Access Boundaries (#99)",
        "My work is human-session-only, refuses deactivated accounts, immediately excludes suspended memberships, revoked grants, terminal/trashed issues and lapsed sessions, and restricts needs-input questions to Contribute/Manage projects",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/my-work/service.ts",
            "apps/server/src/features/my-work/rest.ts",
        ],
    )


def check_m34(facts: dict[str, bool]) -> CheckResult:
    g = {
        "m34_auth_boundary": facts["m34_auth_boundary"],
        "m34_per_issue_sweep_order": facts["m34_per_issue_sweep_order"],
        "m34_atomic_idempotent_schema": facts["m34_atomic_idempotent_schema"],
        "m34_live_access_non_enum": facts["m34_live_access_non_enum"],
        "m34_lossless_cursor_and_prune": facts["m34_lossless_cursor_and_prune"],
    }

    # State: (swept, access_live, trashed, cursor_ok, violations)
    init = (False, True, False, True, frozenset())

    def probe_auth(state):
        sw, acc, tr, cok, v = state
        if not g["m34_auth_boundary"]:
            return (sw, acc, tr, cok, v | {"invalid_bearer_not_401_or_rest_logic"})
        return state

    def run_sweep(state):
        sw, acc, tr, cok, v = state
        if not g["m34_per_issue_sweep_order"]:
            return (True, acc, tr, cok, v | {"sweep_deadlock_or_spurious_expiry"})
        if not g["m34_atomic_idempotent_schema"]:
            return (True, acc, tr, cok, v | {"duplicate_or_denormalized_notification"})
        return (True, acc, tr, cok, v)

    def revoke_or_transfer(state):
        sw, acc, tr, cok, v = state
        return (sw, False, tr, cok, v)

    def trash_issue(state):
        sw, acc, tr, cok, v = state
        return (sw, acc, True, cok, v)

    def read_or_mark(state):
        sw, acc, tr, cok, v = state
        if (not acc or tr) and not g["m34_live_access_non_enum"]:
            return (sw, acc, tr, cok, v | {"inaccessible_notification_leaked"})
        return state

    def paginate_and_prune(state):
        sw, acc, tr, cok, v = state
        if not g["m34_lossless_cursor_and_prune"]:
            return (sw, acc, tr, False, v | {"cursor_truncation_or_missing_prune"})
        return state

    actions = [
        ("invalid bearer / agent key probes notifications", probe_auth),
        ("proactive 60s sweeper settles due question & lapsed lease", run_sweep),
        ("project access revoked or project transferred", revoke_or_transfer),
        ("issue moved to Trash", trash_issue),
        ("human calls list / markRead / markAllRead", read_or_mark),
        ("sub-millisecond keyset pagination and 90/180d prune", paginate_and_prune),
    ]

    def inv(state):
        v = state[-1]
        if v:
            return False, f"notifications invariant broken: {sorted(v)[0]}"
        return True, ""

    return bfs_check(
        "M34",
        "Proactive Expiry Sweeper & In-App Notifications (#123)",
        "Notifications authenticate through AgentAuthenticator (401 invalid, 403 agent), sweep per issue with deadline-before-lease ordering and overlap guard, enforce UNIQUE(human_id, activity_id) without denormalized workspace_id, live-filter access/transfers/Trash on all endpoints, preserve microsecond keyset cursors, and prune at 90/180 days",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/notifications/service.ts",
            "apps/server/src/features/notifications/rest.ts",
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/work-sessions/index.ts",
            "apps/server/src/features/inbox/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0042_nosy_marauders.sql",
        ],
    )


def check_m35(facts: dict[str, bool]) -> CheckResult:
    g = {
        "m35_owner_rbac_and_cap": facts["m35_owner_rbac_and_cap"],
        "m35_explicit_scope_and_transfer_non_widening": facts["m35_explicit_scope_and_transfer_non_widening"],
        "m35_secret_encryption_and_signing": facts["m35_secret_encryption_and_signing"],
        "m35_ssrf_dns_pinned": facts["m35_ssrf_dns_pinned"],
        "m35_atomic_outbox_and_single_enqueue": facts["m35_atomic_outbox_and_single_enqueue"],
        "m35_worker_skip_locked_and_circuit_breaker": facts["m35_worker_skip_locked_and_circuit_breaker"],
    }

    # State: (transferred, disabled, delivered_once, violations)
    init = (False, False, False, frozenset())

    def probe_rbac_and_cap(state):
        tr, dis, dlv, v = state
        if not g["m35_owner_rbac_and_cap"]:
            return (tr, dis, dlv, v | {"non_owner_or_cap_bypass"})
        return state

    def transfer_project(state):
        tr, dis, dlv, v = state
        if not g["m35_explicit_scope_and_transfer_non_widening"]:
            return (True, dis, dlv, v | {"transfer_widened_webhook_scope"})
        return (True, dis, dlv, v)

    def create_rotate_and_sign(state):
        tr, dis, dlv, v = state
        if not g["m35_secret_encryption_and_signing"]:
            return (tr, dis, dlv, v | {"secret_encryption_or_signing_broken"})
        return state

    def ssrf_and_pinned_connect(state):
        tr, dis, dlv, v = state
        if not g["m35_ssrf_dns_pinned"]:
            return (tr, dis, dlv, v | {"ssrf_or_dns_pinning_broken"})
        return state

    def enqueue_activity(state):
        tr, dis, dlv, v = state
        if not g["m35_atomic_outbox_and_single_enqueue"]:
            return (tr, dis, True, v | {"duplicate_enqueue_or_stale_status"})
        return (tr, dis, True, v)

    def drain_and_circuit_breaker(state):
        tr, dis, dlv, v = state
        if not g["m35_worker_skip_locked_and_circuit_breaker"]:
            return (tr, True, dlv, v | {"worker_lock_or_circuit_breaker_broken"})
        return (tr, True, dlv, v)

    actions = [
        ("non-owner / agent / concurrent cap probe", probe_rbac_and_cap),
        ("single-project webhook transferred out of workspace", transfer_project),
        ("create, rotate secret, and sign metadata-only envelope", create_rotate_and_sign),
        ("deliver with DNS-pinned SSRF guard and bounded stream handling", ssrf_and_pinned_connect),
        ("review handoff and session expiry enqueue in activity tx", enqueue_activity),
        ("SKIP LOCKED outbox drain, disable guard, circuit breaker, and 30d prune", drain_and_circuit_breaker),
    ]

    def inv(state):
        v = state[-1]
        if v:
            return False, f"webhooks invariant broken: {sorted(v)[0]}"
        return True, ""

    return bfs_check(
        "M35",
        "Outgoing Webhooks Outbox, Transfer Scope, SSRF DNS Pinning & Circuit Breaker (#124)",
        "Webhooks enforce owner-only RBAC and workspace-locked 20-cap, preserve explicit non-widening scope across project transfers, encrypt whsec_ secrets and sign metadata-only v1 payloads, enforce DNS-pinned SSRF protection with bounded stream handling, enqueue once per activity in-tx with fresh status, and drain via SKIP LOCKED with disabled-hook cancellation, 10-failure auto-disable (excluding webhook.test), and 30-day pruning",
        "safety",
        init,
        lambda s: [(lbl, fn(s)) for lbl, fn in actions],
        inv,
        [
            "apps/server/src/features/webhooks/service.ts",
            "apps/server/src/features/webhooks/rest.ts",
            "apps/server/src/features/webhooks/index.ts",
            "apps/server/src/features/transfers/service.ts",
            "apps/server/src/features/work-sessions/service.ts",
            "packages/contract/src/webhooks.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0043_round_demogoblin.sql",
        ],
    )


def check_m36(facts: dict[str, bool]) -> CheckResult:
    """Avatar upload racing the orphan sweep; the claim-first compare-and-swap.

    State: (up, sweep, row, blob, human, stale, reported, violations)
      up:    idle | reserved | put_done | committed | expired | fk_error
      sweep: idle | selected | blob_deleted | delete_failed | done
      row:   absent | pending | active | deleted
    """
    g = {
        "m36_sweep_claims_before_delete": facts["m36_sweep_claims_before_delete"],
        "m36_pending_only_activation": facts["m36_pending_only_activation"],
        "m36_zero_row_clean_error": facts["m36_zero_row_clean_error"],
        "m36_discard_returning_count": facts["m36_discard_returning_count"],
        "m36_overlap_guard": facts["m36_overlap_guard"],
    }
    files = [
        "apps/server/src/features/avatars/service.ts",
        "apps/server/src/platform/object-sweep.ts",
        "apps/server/src/features/avatars/rest.ts",
    ]
    # (up, sweep, row, blob, human, stale, reported, violations)
    init = ("idle", "idle", "absent", False, False, False, False, frozenset())

    def bad(v: frozenset[str], name: str) -> frozenset[str]:
        return v | {name}

    def run(check_id: str) -> CheckResult:
        def reserve(state):
            up, sw, row, blob, human, stale, reported, v = state
            if up == "idle":
                return ("reserved", sw, "pending", False, False, False, False, v)
            return state

        def put_blob(state):
            up, sw, row, blob, human, stale, reported, v = state
            if up == "reserved":
                return ("put_done", sw, row, True, human, stale, False, v)
            return state

        def clock(state):
            up, sw, row, blob, human, stale, reported, v = state
            if row == "pending" and not stale:
                return (up, sw, row, blob, human, True, reported, v)
            return state

        def activate(state):
            up, sw, row, blob, human, stale, reported, v = state
            if up != "put_done":
                return state
            if row == "pending":
                # Compare-and-swap wins: this is the live avatar and its blob stays.
                return ("committed", sw, "active", blob, True, stale, reported, v)
            # The sweep claimed or hard-deleted the row. Without the status guard
            # the unconditional UPDATE un-deletes a claimed row; otherwise the
            # guarded UPDATE matches nothing.
            if not g["m36_pending_only_activation"] and row == "deleted":
                return ("committed", sw, "active", blob, True, stale, reported, v)
            if g["m36_zero_row_clean_error"]:
                return ("expired", sw, row, blob, False, stale, reported, v)
            # No zero-row check: humans.avatar_object_id is written anyway. An
            # absent row raises the unhandled 23503 from the repro.
            if row == "absent":
                v = bad(v, "unhandled_fk_23503")
            return ("fk_error", sw, row, blob, True, stale, reported, v)

        def sweep_select(state):
            up, sw, row, blob, human, stale, reported, v = state
            if sw != "idle":
                return state
            if row == "deleted":
                return (up, "selected", row, blob, human, stale, False, v)
            if row == "pending" and stale:
                new_row = "deleted" if g["m36_sweep_claims_before_delete"] else "pending"
                return (up, "selected", new_row, blob, human, stale, False, v)
            return state

        def sweep_delete_blob(state):
            up, sw, row, blob, human, stale, reported, v = state
            if sw == "selected":
                return (up, "blob_deleted", row, False, human, stale, reported, v)
            return state

        def sweep_delete_blob_fails(state):
            up, sw, row, blob, human, stale, reported, v = state
            if sw == "selected":
                # store.delete threw: discardObject must report no reclamation.
                reported_next = reported if g["m36_discard_returning_count"] else True
                return (up, "delete_failed", row, blob, human, stale, reported_next, v)
            return state

        def sweep_delete_row(state):
            up, sw, row, blob, human, stale, reported, v = state
            if sw != "blob_deleted":
                return state
            if row == "deleted":
                next_row = "absent"
            elif not g["m36_sweep_claims_before_delete"] and row == "pending" and stale:
                next_row = "absent"  # the old isOrphan predicate
            else:
                next_row = row
            reported_next = next_row == "absent" if g["m36_discard_returning_count"] else True
            return (up, "done", next_row, blob, human, stale, reported_next, v)

        def second_tick(state):
            up, sw, row, blob, human, stale, reported, v = state
            if sw in ("selected", "blob_deleted", "delete_failed") and not g["m36_overlap_guard"]:
                return (
                    up, sw, row, blob, human, stale, reported,
                    bad(v, "overlapping_sweep_started"),
                )
            return state

        actions = [
            ("upload reserves a pending stored_objects row", reserve),
            ("upload writes the WebP blob with store.put", put_blob),
            ("15 minutes pass in DB time", clock),
            ("upload activates the object and sets humans.avatar_object_id", activate),
            ("orphan sweep claims the stale pending row before store.delete", sweep_select),
            ("sweep deletes the claimed blob", sweep_delete_blob),
            ("blob backend delete fails, leaving the claimed row", sweep_delete_blob_fails),
            ("sweep hard-deletes the metadata row and reports reclaimed", sweep_delete_row),
            ("overlapping 60s background tick starts a second sweep", second_tick),
        ]

        def inv(state):
            up, sw, row, blob, human, stale, reported, v = state
            if v:
                return False, f"avatar lifecycle invariant broken: {sorted(v)[0]}"
            if human and not blob:
                return False, "avatar lifecycle invariant broken: active_avatar_has_no_blob"
            if human and row != "active":
                return False, "avatar lifecycle invariant broken: avatar_points_at_non_active_row"
            if up == "fk_error":
                return False, "avatar lifecycle invariant broken: unhandled_fk_23503"
            if sw in ("done", "delete_failed") and reported and row != "absent":
                return False, "avatar lifecycle invariant broken: false_reclaimed_count"
            return True, ""

        return bfs_check(
            check_id,
            "Avatar Upload / Orphan Sweep Claim-First Lifecycle",
            "An active avatar always keeps its blob: the sweep claims a stale pending row before store.delete, upload activates only a still-pending row and fails cleanly when the claim won, discardObject reports only rows it really deleted, and the background sweep cannot overlap itself",
            "safety",
            init,
            lambda s: [(label, action(s)) for label, action in actions],
            inv,
            files,
        )

    result = run("M36")
    if result.status != "verified":
        return result

    # Sensitivity: flip each extracted guard on its own. If any flip still passes,
    # the model proves nothing and is reported as a failure.
    for guard in [key for key in g if key.startswith("m36_")]:
        saved = g[guard]
        g[guard] = not saved
        try:
            naive = run(f"M36-naive-{guard}")
        finally:
            g[guard] = saved
        if naive.status == "verified":
            return CheckResult(
                "M36", result.model, result.property_name, result.kind, "violated",
                result.states_explored, result.transitions_explored,
                f"model is not sensitive: flipping {guard} left the invariant intact",
                [f"flip {guard}"], files,
            )
    return CheckResult(
        "M36", result.model, result.property_name, result.kind, "verified",
        result.states_explored, result.transitions_explored,
        f"{result.summary}; all {len(g)} source guards proven sensitive by single-guard mutation",
        [], files,
    )


def check_m37(facts: dict[str, bool]) -> CheckResult:
    """#175: optional assignee and labels are validated inside the creation transaction.

    State: (issue_count, labels, assignee, violations). A rejected request must leave
    both the issue count and its local number untouched; a successful one must carry
    only same-project labels and a valid workspace assignee.
    """
    g = {k: facts[k] for k in facts if k.startswith("m37_")}

    def bad(v: frozenset[str], reason: str) -> frozenset[str]:
        return v | {reason}

    def create(target: str, labels: tuple[str, ...]):
        def step(state):
            count, attached, assignee, v = state
            if not (g["m37_contract_surface"] and g["m37_mcp_surface"]):
                v = bad(v, "creation_fields_not_representable")
            if not g["m37_problem_details"]:
                v = bad(v, "invalid_triage_not_problem_details")
            if not g["m37_single_transaction"]:
                # A failure after the insert or counter update leaves a partial issue.
                v = bad(v, "triage_applied_outside_transaction")
            foreign = any(label not in ("a", "b") for label in labels)
            bad_assignee = target not in ("none", "human", "agent")
            if foreign and not g["m37_labels_in_tx"]:
                return (min(2, count + 1), frozenset(labels), target, bad(v, "foreign_label_accepted"))
            if bad_assignee and not g["m37_assignee_in_tx"]:
                return (min(2, count + 1), frozenset(labels), target, bad(v, "unknown_assignee_accepted"))
            if foreign or bad_assignee:
                # The validated transaction rolls back: no issue and no number consumed.
                return state
            if len(labels) != len(set(labels)) and not g["m37_labels_in_tx"]:
                v = bad(v, "duplicate_label_rows")
            return (min(2, count + 1), frozenset(labels), target, v)

        return step

    actions = [
        ("create an unassigned issue", create("none", ())),
        ("create an issue assigned to a human", create("human", ("a",))),
        ("create an issue assigned to an agent", create("agent", ("a", "b"))),
        ("create with duplicate label ids", create("none", ("a", "a"))),
        ("create with a label from another project", create("none", ("foreign",))),
        ("create with an unknown label", create("human", ("unknown",))),
        ("create with an unknown assignee", create("missing", ("a",))),
        ("create with invalid assignee and foreign label", create("missing", ("foreign",))),
    ]
    init = (0, frozenset(), "none", frozenset())

    def inv(state):
        count, attached, assignee, v = state
        if v:
            return False, f"atomic creation invariant broken: {sorted(v)[0]}"
        if not attached <= {"a", "b"}:
            return False, "issue carries a label outside the project"
        if assignee not in ("none", "human", "agent"):
            return False, "issue carries an unvalidated assignee"
        return True, ""

    return bfs_check(
        "M37",
        "Atomic Issue Creation with Triage (#175)",
        "create_issue accepts optional assignee and labelIds on REST and MCP; all values are validated in one transaction so an invalid value returns Problem Details without creating a partial issue or consuming its number",
        "safety",
        init,
        lambda s: [(label, fn(s)) for label, fn in actions],
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/projects/rest.ts",
            "apps/server/src/features/projects/mcp.ts",
            "packages/contract/src/projects.ts",
            "packages/contract/src/mcp-tools.ts",
        ],
    )



def check_m38(facts: dict[str, bool]) -> CheckResult:
    """#177: attachment upload races the shared sweep; references are unique and cascading.

    State: (up, obj, blob, att, refs, violations)
      up:  idle | reserved | put_done | committed | expired | fk_error | cleaned
      obj: absent | pending | active | deleted
    """
    g = {k: facts[k] for k in facts if k.startswith("m38_")}
    files = [
        "apps/server/src/features/attachments/service.ts",
        "apps/server/src/features/attachments/rest.ts",
        "apps/server/src/db/schema.ts",
        "apps/server/src/platform/object-sweep.ts",
    ]
    init = ("idle", "absent", False, False, (), frozenset())

    def bad(v: frozenset[str], name: str) -> frozenset[str]:
        return v | {name}

    def run(check_id: str) -> CheckResult:
        def reserve(state):
            up, obj, blob, att, refs, v = state
            return ("reserved", "pending", False, False, (), v) if up == "idle" else state

        def put_blob(state):
            up, obj, blob, att, refs, v = state
            return ("put_done", obj, True, att, refs, v) if up == "reserved" else state

        def sweep_claims(state):
            up, obj, blob, att, refs, v = state
            if obj == "pending":
                return (up, "deleted", blob, att, refs, v)
            return state

        def activate(state):
            up, obj, blob, att, refs, v = state
            if up != "put_done":
                return state
            if obj == "pending":
                return ("committed", "active", blob, True, refs, v)
            if not g["m38_pending_only_activation"] and obj == "deleted":
                # An unconditional UPDATE un-deletes a row the sweep already claimed.
                return ("committed", "active", blob, True, refs, bad(v, "claimed_row_undeleted"))
            if g["m38_pending_only_activation"] and not g["m38_zero_row_clean_error"]:
                # The guarded UPDATE matched nothing, but no zero-row check means
                # the attachments INSERT runs against a claimed/absent object.
                return ("fk_error", obj, blob, True, refs, bad(v, "unhandled_fk_23503"))
            if not g["m38_attachment_row_in_tx"]:
                # Promotion commits but no attachments row is paired with it.
                return ("committed", obj, blob, False, refs, bad(v, "active_blob_without_attachment"))
            return ("expired", obj, blob, False, refs, v)

        def bind(state):
            up, obj, blob, att, refs, v = state
            if not att:
                return state
            duplicate = bool(refs)
            if duplicate:
                if not g["m38_unique_reference"]:
                    return (up, obj, blob, att, refs + ("holder",), bad(v, "duplicate_reference_counted_twice"))
                return state  # the unique index absorbs the duplicate URL
            return (up, obj, blob, att, refs + ("holder",), v)

        def delete_attachment(state):
            up, obj, blob, att, refs, v = state
            if not att:
                return state
            keep_refs = refs if not g["m38_reference_cascade"] else ()
            if keep_refs:
                v = bad(v, "orphan_reference_row")
            return ("cleaned", obj, blob, False, keep_refs, v)

        actions = [
            ("upload reserves a pending stored_objects row", reserve),
            ("upload writes the blob with store.put", put_blob),
            ("the shared sweep claims the stale pending row", sweep_claims),
            ("upload promotes pending and inserts the attachments row", activate),
            ("save binds an attachment URL twice in one body", bind),
            ("save deletes the attachment row", delete_attachment),
        ]
        init_state = init

        def inv(state):
            up, obj, blob, att, refs, v = state
            if v:
                return False, f"attachment lifecycle invariant broken: {sorted(v)[0]}"
            if up == "committed" and not (blob and att):
                return False, "attachment lifecycle invariant broken: active_upload_without_blob_or_row"
            if up == "fk_error":
                return False, "attachment lifecycle invariant broken: unhandled_fk_23503"
            if len(refs) > 1:
                return False, "attachment lifecycle invariant broken: duplicate_reference_rows"
            if not att and refs:
                return False, "attachment lifecycle invariant broken: orphan_reference_rows"
            return True, ""

        return bfs_check(
            check_id,
            "Project Attachment Upload & Reference Lifecycle (#177)",
            "An upload only yields a downloadUrl when pending-to-active promotion and the attachments row commit together; a sweep that won the claim returns a clean Problem, and every holder binds an attachment at most once with cascading reference cleanup",
            "safety",
            init_state,
            lambda s: [(label, action(s)) for label, action in actions],
            inv,
            files,
        )

    result = run("M38")
    if result.status != "verified":
        return result
    for guard in [key for key in g if key.startswith("m38_")]:
        saved = g[guard]
        g[guard] = not saved
        try:
            naive = run(f"M38-naive-{guard}")
        finally:
            g[guard] = saved
        if naive.status == "verified":
            return CheckResult(
                "M38", result.model, result.property_name, result.kind, "violated",
                result.states_explored, result.transitions_explored,
                f"model is not sensitive: flipping {guard} left the invariant intact",
                [f"flip {guard}"], files,
            )
    return CheckResult(
        "M38", result.model, result.property_name, result.kind, "verified",
        result.states_explored, result.transitions_explored,
        f"{result.summary}; all {len(g)} source guards proven sensitive by single-guard mutation",
        [], files,
    )


def check_m39(facts: dict[str, bool]) -> CheckResult:
    """#179: reference sync locks, 24h grace sweep, Trash preservation and purge cleanup.

    State: (phase, refs, issue, hours, trash_expired, sweeping, violations)
      phase: absent | unreferenced | referenced | deleted | blob_gone
      refs: holders currently binding the attachment (issue, comment, knowledge, live)
    """
    g = {k: facts[k] for k in facts if k.startswith("m39_")}
    files = [
        "apps/server/src/features/attachments/service.ts",
        "apps/server/src/features/attachments/index.ts",
        "apps/server/src/features/projects/service.ts",
        "packages/contract/src/attachments.ts",
        "packages/contract/src/projects.ts",
        "contract/openapi.json",
        "contract/mcp-tools.json",
    ]
    init = ("absent", frozenset(), "live", 0, False, False, frozenset())

    def bad(v, name):
        return v | {name}

    def run(check_id: str) -> CheckResult:
        def upload(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            return ("unreferenced", frozenset(), "live", 0, False, False, v) if phase == "absent" else state

        def save_bind(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase in ("deleted", "blob_gone") or issue == "purged":
                return state
            if not g["m39_dedupe"]:
                v = bad(v, "duplicate_reference_rows")
            if not g["m39_unref_clear"]:
                v = bad(v, "grace_not_cleared_on_bind")
            return ("referenced", frozenset({"issue", "comment", "knowledge", "live"}),
                    issue, hours, expired, sweeping, v)

        def bind_live_only(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase in ("deleted", "blob_gone") or issue == "purged":
                return state
            return ("referenced", frozenset({"live"}), issue, hours, expired, sweeping, v)

        def edit_drop(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase != "referenced" or not refs:
                return state
            if not g["m39_unref_reset"] and hours >= 24:
                v = bad(v, "fresh_grace_not_started")
            return ("unreferenced", frozenset(), issue, hours, expired, sweeping, v)

        def tick(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            return (phase, refs, issue, min(25, hours + 1), expired, sweeping, v)

        def age_trash(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            return (phase, refs, issue, hours, True, sweeping, v) if issue == "trash" else state

        def trash_issue(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if issue != "live":
                return state
            if not g["m39_trash_preserve"]:
                return (phase, frozenset(), "trash", hours, False, sweeping,
                        bad(v, "trash_lost_attachment"))
            return (phase, refs, "trash", hours, False, sweeping, v)

        def restore_issue(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            return (phase, refs, "live", hours, False, sweeping, v) if issue == "trash" and not expired else state

        def concurrent_save_purge(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if issue == "trash" and refs and not g["m39_holder_before_attachment"]:
                return (phase, refs, issue, hours, expired, sweeping, bad(v, "ab_ba_deadlock"))
            return state

        def purge(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if issue != "trash" or not expired:
                return state
            if not g["m39_purge_issue_lock"]:
                v = bad(v, "purge_raced_restore")
            remaining = set(refs) - {"issue", "comment"}
            if not g["m39_purge_holders"] and "comment" in refs:
                v = bad(v, "comment_refs_left_after_purge")
                remaining.add("comment")
            if remaining:
                return ("referenced", frozenset(remaining), "purged", hours, True, sweeping, v)
            if not g["m39_atomic_reclaim"]:
                v = bad(v, "fk_zombie_from_split_delete")
            return ("deleted", frozenset(), "purged", hours, True, sweeping, v)

        def start_sweep(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if sweeping and not g["m39_background_overlap"]:
                return (phase, refs, issue, hours, expired, sweeping,
                        bad(v, "overlapping_sweep_ticks"))
            return (phase, refs, issue, hours, expired, True, v) if not sweeping else state

        def sweep(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if not sweeping:
                return state
            if not g["m39_sweep_lock_expiry"] and hours < 24 and phase == "unreferenced":
                v = bad(v, "draft_deleted_before_24h")
            if not g["m39_sweep_recheck"] and refs and phase in ("unreferenced", "referenced"):
                v = bad(v, "live_ref_deleted_by_sweep")
            eligible = phase == "unreferenced" and hours >= 24 and not refs
            if eligible:
                if not g["m39_atomic_reclaim"]:
                    v = bad(v, "fk_zombie_from_split_delete")
                return ("deleted", frozenset(), issue, hours, expired, False, v)
            return (phase, refs, issue, hours, expired, False, v)

        def sweep_wins_race(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase != "unreferenced" or hours < 24:
                return state
            if not g["m39_atomic_reclaim"]:
                v = bad(v, "fk_zombie_from_split_delete")
            return ("deleted", frozenset(), issue, hours, expired, sweeping, v)

        def late_save(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase in ("deleted", "blob_gone") and not g["m39_active_only"]:
                return (phase, refs | {"late"}, issue, hours, expired, sweeping,
                        bad(v, "reclaimed_url_rebound"))
            return state  # inert text: no reference row, no rewrite, no error

        def save_wins_race(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase != "unreferenced" or hours < 24 or issue == "purged":
                return state
            if not g["m39_sync_row_lock"]:
                return (phase, refs, issue, hours, expired, sweeping,
                        bad(v, "save_race_no_row_lock"))
            return ("referenced", refs | {"issue"}, issue, hours, expired, sweeping, v)

        def orphan_sweep(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            return ("blob_gone", refs, issue, hours, expired, sweeping, v) if phase == "deleted" else state

        def read_responses(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase == "referenced" and not g["m39_metadata_rest_mcp"]:
                return (phase, refs, issue, hours, expired, sweeping,
                        bad(v, "metadata_missing_from_rest_mcp"))
            return state

        def swap_dropped_and_added(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if phase != "referenced" or issue == "purged":
                return state
            # An edit drops A and adds B with A < B: locking only the added row
            # before updating A inverts the ascending-id lock order.
            if not g["m39_sync_lock_union"]:
                return (phase, refs, issue, hours, expired, sweeping,
                        bad(v, "dropped_then_added_ab_ba_deadlock"))
            return state

        def purge_two_expired_issues(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if issue != "trash" or not expired or not refs:
                return state
            # A per-issue purge locks B from issue 1, then A from issue 2 (A < B).
            if not g["m39_purge_single_batch"]:
                return (phase, refs, issue, hours, expired, sweeping,
                        bad(v, "multi_issue_purge_ab_ba_deadlock"))
            return state

        def noop_knowledge_patch(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if "knowledge" in refs and not g["m39_knowledge_noop_metadata"]:
                return (phase, refs, issue, hours, expired, sweeping,
                        bad(v, "noop_response_missing_metadata"))
            return state

        actions = [
            ("upload starts a 24h unreferenced grace window", upload),
            ("save binds same-project attachment URLs (twice in one body)", save_bind),
            ("save binds only a cross-referenced live issue", bind_live_only),
            ("an edit drops the last reference", edit_drop),
            ("an edit drops A and adds B in one save", swap_dropped_and_added),
            ("a no-op knowledge PATCH reads bound metadata", noop_knowledge_patch),
            ("the database clock advances", tick),
            ("the issue is moved to Trash", trash_issue),
            ("a Trash issue is restored", restore_issue),
            ("the Trash window expires", age_trash),
            ("a save races a purge on a Trash issue", concurrent_save_purge),
            ("purgeExpiredTrash scrubs an expired issue and its comments", purge),
            ("one batch purge handles several expired issues", purge_two_expired_issues),
            ("the 24h sweep tick starts", start_sweep),
            ("the 24h sweep locks and re-verifies candidates", sweep),
            ("the 24h sweep wins the race against a late save", sweep_wins_race),
            ("a late save binds the row before the sweep rechecks", save_wins_race),
            ("a late save sees a reclaimed URL", late_save),
            ("the shared orphan sweep removes blob and metadata row", orphan_sweep),
            ("REST and MCP read an issue, comments or knowledge", read_responses),
        ]

        def inv(state):
            phase, refs, issue, hours, expired, sweeping, v = state
            if v:
                return False, f"attachment lifecycle invariant broken: {sorted(v)[0]}"
            if refs and phase in ("deleted", "blob_gone"):
                return False, "attachment lifecycle invariant broken: NoDanglingLiveRef"
            if issue == "purged" and refs & {"issue", "comment"}:
                return False, "attachment lifecycle invariant broken: purged_issue_holds_live_ref"
            if issue == "trash" and "issue" in refs and phase == "deleted":
                return False, "attachment lifecycle invariant broken: TrashPreservesAttachment"
            return True, ""

        return bfs_check(
            check_id,
            "Attachment Reference Sync, Grace Sweep & Trash Purge (#179)",
            "A save locks the holder then the attachment rows and binds only live same-project blobs; the 24h sweep re-verifies zero references under its row lock and reclaims the attachment row and stored object atomically; Trash preserves references until a 30-day purge removes the issue's and its comments' references before reclaiming zero-reference attachments",
            "safety",
            init,
            lambda s: [(label, action(s)) for label, action in actions],
            inv,
            files,
        )

    result = run("M39")
    if result.status != "verified":
        return result
    for guard in [key for key in g if key.startswith("m39_")]:
        saved = g[guard]
        g[guard] = not saved
        try:
            naive = run(f"M39-naive-{guard}")
        finally:
            g[guard] = saved
        if naive.status == "verified":
            return CheckResult(
                "M39", result.model, result.property_name, result.kind, "violated",
                result.states_explored, result.transitions_explored,
                f"model is not sensitive: flipping {guard} left the invariant intact",
                [f"flip {guard}"], files,
            )
    return CheckResult(
        "M39", result.model, result.property_name, result.kind, "verified",
        result.states_explored, result.transitions_explored,
        f"{result.summary}; all {len(g)} source guards proven sensitive by single-guard mutation",
        [], files,
    )


def check_m40(facts: dict[str, Any]) -> CheckResult:
    # #181: probe the Human-suggestion endpoint with each kind of caller against an
    # existing and a missing workspace, for a co-workspace peer, a stranger, a
    # deactivated peer and a current member. The outcome is derived from source
    # guards, so a removed guard (or a missing route/schema/contract) is a leak.
    files = [
        "apps/server/src/features/workspaces/service.ts",
        "apps/server/src/features/workspaces/rest.ts",
        "packages/contract/src/workspaces.ts",
        "contract/openapi.json",
    ]
    g = {key: value for key, value in facts.items() if key.startswith("m40_")}
    callers = (
        "anonymous",
        "non_member",
        "plain_member",
        "permission_manager",
        "inviter",
        "owner",
        "admin",
    )
    humans = ("peer", "stranger", "deactivated_peer", "member")

    def visible(caller: str, human: str) -> bool:
        if not (g["m40_account"] and g["m40_route"] and g["m40_contract"] and g["m40_openapi"]):
            return False
        if caller == "admin":
            if not g["m40_admin_branch"]:
                return False
            if human == "member" and g["m40_exclude_members"]:
                return False
            if human == "deactivated_peer" and g["m40_active_only"]:
                return False
            if human == "deactivated_peer":
                return True
            return True
        # An ordinary member or a permission manager without invite authority has
        # no suggestion rights; a non-admin owner or delegated inviter may only
        # meet Humans through a shared workspace, so removing the co-workspace
        # predicate exposes installation strangers.
        if caller in ("plain_member", "permission_manager") and g["m40_capability_gate"]:
            return False
        if human == "member":
            return not g["m40_exclude_members"]
        if human == "deactivated_peer":
            return not g["m40_active_only"]
        if human == "stranger":
            return not g["m40_co_workspace"]
        return True

    def run(check_id: str) -> CheckResult:
        def next_states(state):
            if state != ("start",):
                return []
            return [
                (
                    f"{caller} probes {human} (workspace_exists={exists})",
                    ("probed", caller, exists, human),
                )
                for caller in callers
                for exists in (True, False)
                for human in humans
            ]

        def invariant(state):
            if state[0] != "probed":
                return True, ""
            _, caller, exists, human = state
            if caller == "anonymous":
                if not g["m40_http_401"]:
                    return False, "Unauthenticated caller reached the suggestion endpoint"
                return True, ""
            if not exists:
                return True, ""  # every caller gets the same 404 for a missing workspace
            if caller == "non_member":
                if g["m40_workspace_404"] is False:
                    return False, "Non-member distinguished an existing workspace with 403"
                return True, ""
            if not g["m40_bounded"]:
                return False, "Suggestion result set is unbounded"
            if caller in ("plain_member", "permission_manager"):
                if visible(caller, human):
                    return False, f"{caller} without invite authority saw {human}"
                return True, ""
            if caller in ("owner", "inviter"):
                if human in ("stranger", "deactivated_peer", "member") and visible(caller, human):
                    return False, f"Non-admin {caller} enumerated {human} on the installation"
                if human == "peer" and not visible(caller, human):
                    return False, f"Non-admin {caller} cannot see their co-workspace Human"
                return True, ""
            # A system administrator may see any active non-member Human, but
            # never a current member or a deactivated account.
            if human == "stranger" and not visible(caller, human):
                return False, "System administrator cannot see an active Human outside the workspace"
            if human in ("deactivated_peer", "member") and visible(caller, human):
                return False, f"System administrator saw {human}"
            return True, ""

        return bfs_check(
            check_id,
            "Human Suggestion Non-Enumeration",
            "Only active co-workspace Humans are visible to non-admins; current members and deactivated Humans are never suggested; non-members get 404",
            "safety",
            ("start",),
            next_states,
            invariant,
            files,
        )

    result = run("M40")
    if result.status == "verified":
        for guard in sorted(g):
            saved = g[guard]
            g[guard] = not saved
            try:
                naive = run(f"M40-naive-{guard}")
            finally:
                g[guard] = saved
            if naive.status == "verified":
                return CheckResult(
                    "M40",
                    result.model,
                    result.property_name,
                    result.kind,
                    "violated",
                    result.states_explored,
                    result.transitions_explored,
                    f"model is not sensitive: flipping {guard} left the invariant intact",
                    [f"flip {guard}"],
                    files,
                )
    return CheckResult(
        "M40",
        result.model,
        result.property_name,
        result.kind,
        result.status,
        result.states_explored,
        result.transitions_explored,
        (
            f"{result.summary}; all {len(g)} source guards proven sensitive by single-guard mutation"
            if result.status == "verified"
            else result.summary
        ),
        result.counterexample,
        files,
    )


def check_m41(facts: dict[str, bool]) -> CheckResult:
    g = {k: facts[k] for k in facts if k.startswith("m41_")}

    # State: (handles_unique, handle_assigned, notified, events_applied, violations).
    # `events_applied` is the set of mutations already interleaved, so the BFS
    # visits every ordering of the eight #183 transitions.
    init = (True, True, False, frozenset(), frozenset())

    def step(state, label, violation=None, uniq=None, assigned=None, notified=None):
        u, a, n, events, v = state
        return (
            u if uniq is None else uniq,
            a if assigned is None else assigned,
            n if notified is None else notified,
            events | {label},
            v if violation is None else v | {violation},
        )

    def insert_colliding_human(state):
        if not g["m41_handle_check"] or not g["m41_handle_unique"]:
            return step(state, "colliding insert", "duplicate_or_invalid_handle", uniq=False, assigned=True)
        if not g["m41_backfill_before_not_null"]:
            return step(state, "colliding insert", "collision_suffix_not_allocated", uniq=False, assigned=True)
        return step(state, "colliding insert", assigned=True)

    def backfill_legacy_row(state):
        if not g["m41_backfill_before_not_null"]:
            return step(state, "backfill", "legacy_row_left_with_null_handle", assigned=False)
        return step(state, "backfill", assigned=True)

    def create_issue_with_duplicate_mention(state):
        if not g["m41_dedupe_per_event"]:
            return step(state, "create duplicate mention", "duplicate_notification_per_event", notified=True)
        if not g["m41_ignore_non_text"]:
            return step(state, "create duplicate mention", "non_text_mention_notified", notified=True)
        return step(state, "create duplicate mention", notified=True)

    def mention_without_read_access(state):
        if not g["m41_live_read_gate"]:
            return step(state, "non-member mention", "non_member_notified", notified=True)
        return step(state, "non-member mention")

    def self_mention(state):
        if not g["m41_mention_recipients"]:
            return step(state, "self mention", "self_notified", notified=True)
        return step(state, "self mention")

    def edit_adds_mention(state):
        if not g["m41_mention_diff"]:
            return step(state, "edit adds mention", "already_mentioned_notified_again", notified=True)
        return step(state, "edit adds mention", notified=True)

    def edit_keeps_mention(state):
        if not g["m41_mention_diff"]:
            return step(state, "edit keeps mention", "unchanged_mention_notified_again", notified=True)
        return step(state, "edit keeps mention")

    def mention_inside_code_or_email(state):
        if not g["m41_ignore_non_text"]:
            return step(state, "code mention", "non_text_mention_notified", notified=True)
        return step(state, "code mention")

    actions = [
        ("insert a second human whose email derives to the same handle", insert_colliding_human),
        ("backfill a legacy human row", backfill_legacy_row),
        ("create an issue that mentions the same valid handle twice", create_issue_with_duplicate_mention),
        ("mention a human without live project Read access", mention_without_read_access),
        ("mention yourself in your own issue", self_mention),
        ("edit an issue to add a mention", edit_adds_mention),
        ("edit an issue without adding a mention", edit_keeps_mention),
        ("write @handle inside code, a link or an email address", mention_inside_code_or_email),
    ]

    def inv(state):
        uniq, assigned, notified, events, v = state
        if not uniq:
            return False, "human handles are not unique or valid"
        if not assigned:
            return False, "a human row was left without a handle"
        if v:
            return False, f"mention invariant broken: {sorted(v)[0]}"
        return True, ""

    return bfs_check(
        "M41",
        "Human Handles and @Mentions (#183)",
        "Handles are backfilled and unique; mention notifications are deduplicated, gated on live Read access, never self-sent, and only newly added on an edit",
        "safety",
        init,
        lambda s: [(label, fn(s)) for label, fn in actions],
        inv,
        [
            "apps/server/src/db/schema.ts",
            "db/migrations/0047_adorable_hammerhead.sql",
            "db/migrations/0048_backfill_human_handles.sql",
            "apps/server/src/features/notifications/service.ts",
            "apps/server/src/features/notifications/mentions.ts",
            "apps/server/src/features/projects/service.ts",
            "packages/contract/src/notifications.ts",
        ],
    )


def check_m42(facts: dict[str, Any]) -> CheckResult:
    """#195: device-code enrollment, DB-time presence and scoped revocation cascades.

    The explorer interleaves enrollment, registration, fleet reads, heartbeat and
    the three offboarding cascades. Each transition derives its outcome from the
    guards extracted from the live runners/deactivation/workspaces sources, so a
    removed guard produces a named counterexample. A verified baseline is then
    required to break when every single guard is flipped in turn.
    """
    files = [
        "apps/server/src/features/runners/service.ts",
        "apps/server/src/features/runners/rest.ts",
        "apps/server/src/features/deactivation/service.ts",
        "apps/server/src/features/workspaces/service.ts",
        "apps/server/src/db/schema.ts",
        "packages/contract/src/runners.ts",
        "contract/openapi.json",
        "db/migrations/0050_gray_winter_soldier.sql",
    ]
    g = {k: v for k, v in facts.items() if k.startswith("m42_")}

    def violations_for(action: str, applied: frozenset[str]) -> set[str]:
        bad: set[str] = set()
        if action == "enroll_exchange":
            if not g["m42_exchange_for_update"]:
                bad.add("racing_exchange_bypassed_row_lock")
            if not g["m42_single_use"]:
                bad.add("device_code_exchanged_twice")
            if not g["m42_db_time_expiry"]:
                bad.add("expired_code_exchanged_in_local_time")
            if not g["m42_verifier_binding"]:
                bad.add("wrong_verifier_exchanged")
            if not g["m42_capped_increments"]:
                bad.add("failed_attempt_check_constraint_23514")
            if not g["m42_approve_post"]:
                bad.add("device_code_approved_by_get")
        elif action == "approve_window":
            if not g["m42_attempt_window"]:
                bad.add("permanent_failed_user_code_lockout")
        elif action == "register_guards":
            if not g["m42_workspace_before_project"]:
                bad.add("project_existence_leaked_before_workspace_check")
            if not g["m42_project_access"]:
                bad.add("runner_bound_without_project_access")
            if not g["m42_same_human_agent"]:
                bad.add("foreign_human_agent_bound_to_runner")
        elif action == "presence":
            if not g["m42_db_time_presence"]:
                bad.add("presence_stored_as_mutable_boolean")
        elif action == "heartbeat":
            revoked_by_deactivation = (
                "deactivate" in applied
                and g["m42_deactivation_revoke_hosts"]
                and g["m42_host_cascade_runners"]
            )
            revoked_by_member_removal = (
                "member_removed" in applied and g["m42_member_revoke_runners"]
            )
            revoked_by_host = "host_revoked" in applied and g["m42_host_revoke_in_tx"]
            if (revoked_by_deactivation or revoked_by_member_removal or revoked_by_host) and not g[
                "m42_heartbeat_revoked_401"
            ]:
                bad.add("revoked_runner_told_to_keep_running")
            if ("member_removed" in applied or "host_revoked" in applied) and not g[
                "m42_heartbeat_access_401"
            ]:
                bad.add("runner_kept_heartbeating_after_losing_access")
            if not g["m42_slot_count_400"]:
                bad.add("slot_count_reported_as_revoked_credential")
        elif action == "fleet":
            if not g["m42_fleet_read_filter"]:
                bad.add("unreadable_project_listed_in_fleet")
        elif action == "deactivate":
            if not g["m42_deactivation_revoke_hosts"]:
                bad.add("runner_host_survived_human_deactivation")
            if not g["m42_host_cascade_runners"]:
                bad.add("runner_survived_host_revocation")
        elif action == "member_removed":
            if not g["m42_member_revoke_runners"]:
                bad.add("runner_survived_workspace_member_removal")
            if not g["m42_member_scope_only"]:
                bad.add("installation_host_revoked_by_member_removal")
        elif action == "host_revoked":
            if not g["m42_host_revoke_in_tx"]:
                bad.add("host_revocation_left_runners_live")
        elif action == "contract":
            if not g["m42_contract_and_contract_surface"]:
                bad.add("runner_routes_or_contract_missing")
        return bad

    actions = (
        "enroll_exchange",
        "approve_window",
        "register_guards",
        "presence",
        "heartbeat",
        "fleet",
        "deactivate",
        "member_removed",
        "host_revoked",
        "contract",
    )

    def run(check_id: str) -> CheckResult:
        init = (frozenset(), frozenset())

        def next_states(state):
            applied, _violations = state
            for action in actions:
                if action in applied:
                    continue
                found = violations_for(action, applied)
                yield f"{action} (after {sorted(applied)})", (applied | {action}, frozenset(found))

        def invariant(state):
            _applied, violations = state
            if violations:
                return False, f"runner invariant broken: {sorted(violations)[0]}"
            return True, ""

        return bfs_check(
            check_id,
            "Runner Host Enrollment, DB-Time Presence & Revocation Cascades (#195)",
            "Device codes are verifier-bound, single-use and DB-time expired; registration never leaks project existence or binds a foreign Agent; presence is derived in DB time; host/deactivation/member-removal revocations are scoped and leave the Runner with a 401 heartbeat",
            "safety",
            init,
            next_states,
            invariant,
            files,
        )

    result = run("M42")
    if result.status == "verified":
        for guard in sorted(g):
            saved = g[guard]
            g[guard] = not saved
            try:
                naive = run(f"M42-naive-{guard}")
            finally:
                g[guard] = saved
            if naive.status == "verified":
                return CheckResult(
                    "M42",
                    result.model,
                    result.property_name,
                    result.kind,
                    "violated",
                    result.states_explored,
                    result.transitions_explored,
                    f"model is not sensitive: flipping {guard} left the invariant intact",
                    [f"flip {guard}"],
                    files,
                )
    return CheckResult(
        "M42",
        result.model,
        result.property_name,
        result.kind,
        result.status,
        result.states_explored,
        result.transitions_explored,
        (
            f"{result.summary}; all {len(g)} source guards proven sensitive by single-guard mutation"
            if result.status == "verified"
            else result.summary
        ),
        result.counterexample,
        files,
    )


def main() -> None:
    facts = extract_code_facts()
    results = [
        check_m1(facts),
        check_m2a(facts),
        check_m2b(facts),
        check_m3(facts),
        check_m4(facts),
        check_m5(facts),
        check_m6(facts),
        check_m7(facts),
        check_m8(facts),
        check_m9(facts),
        check_m10(facts),
        check_m11(facts),
        check_m12(facts),
        check_m13(facts),
        check_m14(facts),
        check_m15(facts),
        check_m16(facts),
        check_m17(facts),
        check_m18(facts),
        check_m19(facts),
        check_m20(facts),
        check_m21(facts),
        check_m22(facts),
        check_m23(facts),
        check_m24(facts),
        check_m25(facts),
        check_m26(facts),
        check_m27(facts),
        check_m28(facts),
        check_m29(facts),
        check_m30(facts),
        check_m31(facts),
        check_m32(facts),
        check_m33(facts),
        check_m34(facts),
        check_m35(facts),
        check_m36(facts),
        check_m37(facts),
        check_m38(facts),
        check_m39(facts),
        check_m40(facts),
        check_m41(facts),
        check_m42(facts),
    ]

    if "--json" in sys.argv:
        print(
            json.dumps(
                {
                    "facts": facts,
                    "results": [r.__dict__ for r in results],
                },
                indent=2,
            )
        )
    else:
        for r in results:
            tag = "PASS" if r.status == "verified" else "FAIL"
            print(f"[{tag}] {r.id} ({r.model}): {r.property_name}")
            print(f"       {r.summary}")
            if r.counterexample:
                print("       Counterexample:")
                for i, step in enumerate(r.counterexample, 1):
                    print(f"         {i}. {step}")

    failed = [r for r in results if r.status != "verified"]
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
