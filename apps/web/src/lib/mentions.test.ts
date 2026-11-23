import type { MentionAgent, MentionHuman } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { filterMentionCandidates, findAtMention, mentionToken } from "./mentions.ts";

const alice: MentionHuman = {
  type: "human",
  id: "h1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice Smith",
  avatarUrl: null,
};
const bob: MentionHuman = {
  type: "human",
  id: "h2",
  handle: "bob-agent",
  email: "bob@example.com",
  displayName: null,
  avatarUrl: null,
};
const agent: MentionAgent = {
  type: "agent",
  id: "a1",
  slug: "codex",
  name: "Codex Worker",
  avatarUrl: null,
};

describe("web @mention helpers", () => {
  it("detects a trailing @ query only at a word boundary", () => {
    expect(findAtMention("hello @ali")).toEqual({ start: 6, query: "ali" });
    expect(findAtMention("hello @")).toEqual({ start: 6, query: "" });
    expect(findAtMention("alice@example.com")).toBeNull();
    expect(findAtMention("hello @alice, next")).toBeNull();
  });

  it("builds handle tokens for humans and agent slugs", () => {
    expect(mentionToken(alice)).toBe("@alice");
    expect(mentionToken(agent)).toBe("@codex");
  });

  it("filters by handle, name or email and caps the list", () => {
    expect(filterMentionCandidates([alice, bob], [agent], "ali")).toEqual([alice]);
    expect(filterMentionCandidates([alice, bob], [agent], "codex")).toEqual([agent]);
    expect(filterMentionCandidates([alice, bob], [agent], "example.com")).toEqual([alice, bob]);
    expect(filterMentionCandidates([alice, bob], [agent], "")).toEqual([alice, bob, agent]);
  });
});
