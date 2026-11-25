import type { MentionCandidatesResponse } from "@orrery/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueMentionTextArea } from "./IssueMentionTextArea.tsx";
import { mentionCandidatesQuery } from "./queries.ts";

const candidates: MentionCandidatesResponse = {
  humans: [
    {
      type: "human",
      id: "h1",
      handle: "alice",
      displayName: "Alice Smith",
      email: "alice@example.com",
      avatarUrl: null,
    },
  ],
  agents: [],
};

function renderComposer(value: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(mentionCandidatesQuery("project-1").queryKey, candidates);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IssueMentionTextArea
        label="Comment"
        id="comment"
        htmlName="comment"
        value={value}
        onChange={() => {}}
        rows={4}
        projectId="project-1"
      />
    </QueryClientProvider>,
  );
}

describe("IssueMentionTextArea", () => {
  it("keeps mention suggestions out of the composer's document flow", () => {
    const html = renderComposer("Hello @");

    expect(html).toContain('id="comment"');
    // The suggestion list lives in an anchored layer, not as a sibling below
    // the composer card and its attachment bar. The server render exposes the
    // layer's inert marker, while the listbox mounts in the popover on the
    // client.
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain("<template>");
  });
});
