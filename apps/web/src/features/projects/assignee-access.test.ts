import type {
  ProjectAccessCandidate as ProjectAccessCandidateRecord,
  WorkspaceMember,
} from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { missingProjectAccessHumanIds, projectAccessCandidates } from "./assignee-access.ts";

function candidate(
  humanId: string,
  overrides: Partial<ProjectAccessCandidateRecord> = {},
): ProjectAccessCandidateRecord {
  return {
    humanId,
    email: `${humanId}@example.com`,
    displayName: null,
    avatarUrl: null,
    ...overrides,
  };
}

function member(humanId: string, overrides: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    humanId,
    email: `${humanId}@example.com`,
    displayName: null,
    avatarUrl: null,
    isOwner: false,
    canCreateProjects: false,
    canInviteMembers: false,
    canRemoveMembers: false,
    canManageMemberPermissions: false,
    ...overrides,
  };
}

describe("project access for member pickers", () => {
  it("labels eligible members and drops a grant made since the list loaded", () => {
    const candidates = projectAccessCandidates(
      [candidate("granted"), candidate("newcomer", { displayName: "New Comer" })],
      ["granted"],
    );
    expect(candidates).toEqual([
      {
        humanId: "newcomer",
        email: "newcomer@example.com",
        displayName: "New Comer",
        avatarUrl: null,
        label: "New Comer",
      },
    ]);
  });

  it("has no candidates when the endpoint reports everyone already has access", () => {
    expect(projectAccessCandidates([], [])).toEqual([]);
    expect(projectAccessCandidates([candidate("reader")], ["reader"])).toEqual([]);
  });

  it("flags workspace members without a grant, but never owners", () => {
    const missing = missingProjectAccessHumanIds(
      [
        member("owner", { isOwner: true }),
        member("granted"),
        member("reader"),
        member("suspended-like", { canCreateProjects: false }),
      ],
      ["granted"],
    );
    expect([...missing].toSorted()).toEqual(["reader", "suspended-like"]);
  });
});
