import type { IssueReference } from "../../lib/Markdown.tsx";
import { Markdown } from "../../lib/Markdown.tsx";
import { useQuery } from "@tanstack/react-query";
import { mentionCandidatesQuery } from "./queries.ts";

/** Markdown with issue links and @mention badges resolved for the current project. */
export function MentionMarkdown({
  children,
  projectId,
  issueRefs,
}: {
  children: string;
  projectId: string;
  issueRefs?: readonly IssueReference[];
}) {
  const candidates = useQuery(mentionCandidatesQuery(projectId));
  const actors =
    candidates.data === undefined ? [] : [...candidates.data.humans, ...candidates.data.agents];
  return (
    <Markdown mentionActors={actors} {...(issueRefs !== undefined ? { issueRefs } : {})}>
      {children}
    </Markdown>
  );
}
