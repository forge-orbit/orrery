import type {
  ProjectAccessCandidate as ProjectAccessCandidateRecord,
  WorkspaceMember,
} from "@orrery/contract";

export type ProjectAccessCandidate = ProjectAccessCandidateRecord & { label: string };

/** Label eligible members and drop any grant made since the candidate list loaded. */
export function projectAccessCandidates(
  candidates: readonly ProjectAccessCandidateRecord[],
  grantedHumanIds: readonly string[],
): ProjectAccessCandidate[] {
  const granted = new Set(grantedHumanIds);
  return candidates
    .filter((candidate) => !granted.has(candidate.humanId))
    .map((candidate) => ({
      humanId: candidate.humanId,
      email: candidate.email,
      displayName: candidate.displayName,
      avatarUrl: candidate.avatarUrl,
      label: candidate.displayName ?? candidate.email,
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
