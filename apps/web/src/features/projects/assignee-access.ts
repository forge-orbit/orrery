import type { WorkspaceMember } from "@orrery/contract";

export type ProjectAccessCandidate = Pick<
  WorkspaceMember,
  "humanId" | "email" | "displayName" | "avatarUrl"
> & { label: string };

/** Members who can still be granted access: no owner, no existing grant. */
export function projectAccessCandidates(
  members: readonly WorkspaceMember[],
  grantedHumanIds: readonly string[],
): ProjectAccessCandidate[] {
  const granted = new Set(grantedHumanIds);
  return members
    .filter((member) => !member.isOwner && !granted.has(member.humanId))
    .map((member) => ({
      humanId: member.humanId,
      email: member.email,
      displayName: member.displayName,
      avatarUrl: member.avatarUrl,
      label: member.displayName ?? member.email,
    }));
}

/** Members who need a grant before they can see a project's issues in My work. */
export function missingProjectAccessHumanIds(
  members: readonly WorkspaceMember[],
  grantedHumanIds: readonly string[],
): Set<string> {
  const granted = new Set(grantedHumanIds);
  return new Set(
    members
      .filter((member) => !member.isOwner && !granted.has(member.humanId))
      .map((member) => member.humanId),
  );
}
