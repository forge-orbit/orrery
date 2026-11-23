import type { WorkspaceMember } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { missingProjectAccessHumanIds, projectAccessCandidates } from "./assignee-access.ts";

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
  it("offers only active members who still need a grant", () => {
    const candidates = projectAccessCandidates(
      [
        member("owner", { isOwner: true }),
        member("granted"),
        member("newcomer", { displayName: "New Comer" }),
      ],
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
