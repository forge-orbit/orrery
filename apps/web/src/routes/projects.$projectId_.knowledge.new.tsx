import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { useToast } from "@astryxdesign/core/Toast";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  createKnowledgeEntry,
  issuesQuery,
  knowledgeEntryQuery,
  knowledgeEntriesQuery,
  projectActivityQuery,
  projectQuery,
  ResourceLoadError,
  TitleBodyForm,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/projects/$projectId_/knowledge/new")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await context.queryClient.ensureQueryData(issuesQuery(project.id));
  },
  component: NewKnowledgePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="project" error={error} />,
});

function NewKnowledgePage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: projectIssues = [] } = useQuery(issuesQuery(projectId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [createMore, setCreateMore] = useState(false);
  const readOnly = project.accessLevel === "read";

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link
            key="project"
            to="/projects/$projectId"
            params={{ projectId }}
            color="secondary"
            weight="medium"
          >
            Back to project
          </Link>,
        ]}
        title="New knowledge document"
        badge="Knowledge"
        subtitle={
          readOnly
            ? undefined
            : `Write in ${project.name}. Supports GitHub-flavored Markdown, Mermaid diagrams, and #issue references.`
        }
      />
      {readOnly ? (
        <Section padding={4}>
          <EmptyState
            title="You cannot create knowledge here"
            description="You have read-only access to this project."
            headingLevel={2}
            actions={
              <Link to="/projects/$projectId" params={{ projectId }}>
                Back to project
              </Link>
            }
          />
        </Section>
      ) : (
        <Section padding={4}>
          <Stack gap={3} width="100%">
            <TitleBodyForm
              idPrefix="new-knowledge"
              titleLabel="Knowledge title"
              bodyLabel="Markdown"
              bodyRows={15}
              submitLabel="Create knowledge"
              fallbackError="Could not create the entry."
              resetOnSuccess
              mentionIssues={projectIssues}
              createMore={{ value: createMore, onChange: setCreateMore }}
              secondaryAction={
                <Button variant="secondary" label="Cancel" href={`/projects/${projectId}`} />
              }
              onSubmit={async ({ title, body }) => {
                const entry = await createKnowledgeEntry(projectId, { title, body });
                queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, entry);
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: knowledgeEntriesQuery(projectId).queryKey,
                  }),
                  queryClient.invalidateQueries({
                    queryKey: projectActivityQuery(projectId).queryKey,
                  }),
                ]);
                if (createMore) {
                  toast({
                    body: "Knowledge document created.",
                    endContent: (
                      <Button
                        size="sm"
                        variant="ghost"
                        label="View knowledge"
                        onClick={() =>
                          void navigate({
                            to: "/knowledge/$entryId",
                            params: { entryId: entry.id },
                          })
                        }
                      />
                    ),
                  });
                  return;
                }
                await navigate({ to: "/knowledge/$entryId", params: { entryId: entry.id } });
              }}
            />
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
