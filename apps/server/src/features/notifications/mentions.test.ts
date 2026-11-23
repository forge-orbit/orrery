import { describe, expect, it } from "vitest";
import { extractMentionHandles, newlyAddedMentions } from "./mentions.ts";

describe("@mention extraction", () => {
  it("finds unique handles regardless of case", () => {
    expect(extractMentionHandles("Hi @alice and @Alice, cc @bob-agent.")).toEqual([
      "alice",
      "bob-agent",
    ]);
  });

  it("ignores code, links and email addresses", () => {
    const body = [
      "```",
      "@in-code",
      "```",
      "`@inline` and [label @linked](https://example.com/@in-url)",
      "Mail alice@example.com, not @mentioned",
      "See https://example.com/@path",
    ].join("\n");
    expect(extractMentionHandles(body)).toEqual(["mentioned"]);
  });

  it("only notifies handles added by an edit", () => {
    expect(newlyAddedMentions("hello @alice", "hello @alice and @bob and @carol")).toEqual([
      "bob",
      "carol",
    ]);
    expect(newlyAddedMentions("hello @alice and @bob", "hello @alice")).toEqual([]);
  });
});
