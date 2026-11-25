import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { useToast } from "@astryxdesign/core/Toast";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useState } from "react";
import {
  issuesQuery,
  MentionMarkdown,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  projectQuery,
  ResourceLoadError,
  TitleBodyForm,
  updateKnowledgeEntry,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import { formatFullDateTime, relativeTime } from "../lib/time.ts";

export const Route = createFileRoute("/knowledge/$entryId")({
  loader: async ({ context, params }) => {
    const entry = await context.queryClient.ensureQueryData(knowledgeEntryQuery(params.entryId));
    await context.queryClient.ensureQueryData(projectQuery(entry.projectId));
  },
  component: KnowledgePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="knowledge" error={error} />,
});

function KnowledgePage() {
  const { entryId } = Route.useParams();
  const { data: entry } = useSuspenseQuery(knowledgeEntryQuery(entryId));
  const { data: project } = useSuspenseQuery(projectQuery(entry.projectId));
  const { data: projectIssues = [] } = useQuery(issuesQuery(entry.projectId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const canContribute = project.accessLevel !== "read";

  return (
    <Stack gap={5} maxWidth="56rem" width="100%">
      <PageHeader
        breadcrumbs={[
          <Link
            key="project"
            to="/projects/$projectId"
            params={{ projectId: entry.projectId }}
            color="secondary"
            weight="medium"
          >
            Back to project
          </Link>,
        ]}
        title={entry.title}
        badge="Knowledge"
        subtitle={
          <>
            Created by {entry.createdBy.displayName} · last edited{" "}
            <time dateTime={entry.updatedAt} title={formatFullDateTime(entry.updatedAt)}>
              {relativeTime(entry.updatedAt)}
            </time>{" "}
            by {entry.updatedBy.displayName}
          </>
        }
        actions={
          canContribute && !isEditing && entry.body !== "" ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Edit"
              icon={<Icon icon={Pencil} />}
              data-knowledge-edit=""
              onClick={() => setIsEditing(true)}
            />
          ) : undefined
        }
      />
      {isEditing ? (
        <Section padding={4}>
          <Stack gap={2} data-knowledge-editor="">
            <TitleBodyForm
              key={entry.updatedAt}
              idPrefix="edit-knowledge"
              titleLabel="Title"
              bodyLabel="Markdown"
              bodyRows={15}
              submitLabel="Save knowledge"
              fallbackError="Could not save the entry."
              initialTitle={entry.title}
              initialBody={entry.body}
              mentionIssues={projectIssues}
              projectId={entry.projectId}
              secondaryAction={
                <Button
                  type="button"
                  variant="secondary"
                  label="Cancel"
                  onClick={() => setIsEditing(false)}
                />
              }
              onSubmit={async ({ title, body }) => {
                const updated = await updateKnowledgeEntry(entry.id, { title, body });
                queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, updated);
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: knowledgeEntriesQuery(entry.projectId).queryKey,
                  }),
                  queryClient.invalidateQueries({
                    queryKey: projectActivityQuery(entry.projectId).queryKey,
                  }),
                ]);
                setIsEditing(false);
                toast({ body: "Knowledge document saved." });
              }}
            />
          </Stack>
        </Section>
      ) : entry.body === "" ? (
        <Section padding={4}>
          <EmptyState
            title="No content yet"
            description="Add architecture notes, runbooks, or project decisions in Markdown."
            isCompact
            headingLevel={2}
            actions={
              canContribute ? (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  label="Add content"
                  onClick={() => setIsEditing(true)}
                />
              ) : undefined
            }
          />
        </Section>
      ) : (
        <Section variant="transparent" padding={0}>
          <Stack data-knowledge-body="" maxWidth="68ch">
            <MentionMarkdown projectId={entry.projectId} issueRefs={projectIssues}>
              {entry.body}
            </MentionMarkdown>
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
