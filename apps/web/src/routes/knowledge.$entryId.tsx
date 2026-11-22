import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { Issue, KnowledgeEntry } from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  issuesQuery,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  projectQuery,
  ResourceLoadError,
  TitleBodyForm,
  updateKnowledgeEntry,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { Markdown } from "../lib/Markdown.tsx";
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
  const [editOpen, setEditOpen] = useState(false);
  const canContribute = project.accessLevel !== "read";

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link key="project" to="/projects/$projectId" params={{ projectId: entry.projectId }}>
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
          canContribute ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Edit"
              onClick={() => setEditOpen(true)}
            />
          ) : undefined
        }
      />
      {entry.body === "" ? (
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
                  onClick={() => setEditOpen(true)}
                />
              ) : undefined
            }
          />
        </Section>
      ) : (
        <Section padding={4}>
          <Stack data-knowledge-body="">
            <Markdown issueRefs={projectIssues}>{entry.body}</Markdown>
          </Stack>
        </Section>
      )}
      {canContribute && (
        <Drawer
          isOpen={editOpen}
          onOpenChange={setEditOpen}
          side="end"
          width="36rem"
          label="Edit knowledge"
        >
          <Layout
            height="fill"
            header={
              <DrawerHeader
                title="Edit knowledge"
                subtitle={project.name}
                onOpenChange={setEditOpen}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <EditKnowledgeForm
                key={entry.updatedAt}
                entry={entry}
                issues={projectIssues}
                onSaved={() => setEditOpen(false)}
              />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}
    </Stack>
  );
}

function EditKnowledgeForm({
  entry,
  issues,
  onSaved,
}: {
  entry: KnowledgeEntry;
  issues: Issue[];
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return (
    <Stack gap={2}>
      <Text as="p" display="block" type="supporting">
        Supports GitHub-flavored Markdown, Mermaid diagrams, and #issue references.
      </Text>
      <TitleBodyForm
        idPrefix="edit-knowledge"
        titleLabel="Title"
        bodyLabel="Markdown"
        bodyRows={14}
        submitLabel="Save knowledge"
        fallbackError="Could not save the entry."
        initialTitle={entry.title}
        initialBody={entry.body}
        mentionIssues={issues}
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
          onSaved();
          toast({ body: "Knowledge document saved." });
        }}
      />
    </Stack>
  );
}
