import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  issueQuery,
  issuesQuery,
  issueStatusLabels,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  knowledgeTrashQuery,
  PriorityBadge,
  projectActivityQuery,
  projectQuery,
  projectTrashQuery,
  readyWorkQuery,
  ResourceLoadError,
  restoreIssue,
  restoreKnowledgeEntry,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import { formatFullDateTime, relativeTime } from "../lib/time.ts";

export const Route = createFileRoute("/trash/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    if (project.accessLevel === "manage") {
      await Promise.all([
        context.queryClient.ensureQueryData(projectTrashQuery(project.id)),
        context.queryClient.ensureQueryData(knowledgeTrashQuery(project.id)),
      ]);
    }
  },
  component: ProjectTrashPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="trash" error={error} />,
});

function ProjectTrashPage() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const canManage = project.accessLevel === "manage";
  const {
    data: trashed,
    isPending,
    isError,
    refetch,
  } = useQuery({ ...projectTrashQuery(projectId), enabled: canManage });
  const {
    data: trashedKnowledge,
    isPending: knowledgePending,
    isError: knowledgeError,
    refetch: refetchKnowledge,
  } = useQuery({ ...knowledgeTrashQuery(projectId), enabled: canManage });
  const [error, setError] = useState<string>();
  const [restoringId, setRestoringId] = useState<string>();

  async function onRestore(issueId: string, identifier: string) {
    setRestoringId(issueId);
    setError(undefined);
    try {
      await restoreIssue(issueId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectTrashQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      toast({ body: `Restored ${identifier}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not restore the issue.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setRestoringId(undefined);
    }
  }

  async function onRestoreKnowledge(entryId: string, title: string) {
    setRestoringId(entryId);
    setError(undefined);
    try {
      await restoreKnowledgeEntry(entryId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: knowledgeTrashQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: knowledgeEntriesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: knowledgeEntryQuery(entryId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      toast({ body: `Restored “${title}”.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not restore the knowledge entry.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setRestoringId(undefined);
    }
  }

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
        title="Trash"
        badge={project.name}
        subtitle="Soft-deleted issues and knowledge stay recoverable for 30 days."
      />
      {error !== undefined && (
        <Banner status="error" role="alert" title="Could not restore item" description={error} />
      )}
      {!canManage ? (
        <Stack padding={4}>
          <EmptyState
            title="Manager access required"
            description="Only a project manager can view and restore trashed items."
            headingLevel={2}
          />
        </Stack>
      ) : (
        <>
          <Stack gap={3}>
            <Heading level={2} color="inherit">
              Issues
            </Heading>
            {isPending ? (
              <Text as="p" display="block" type="supporting" role="status">
                Loading trashed issues…
              </Text>
            ) : isError ? (
              <Banner
                status="error"
                role="alert"
                title="Could not load trash"
                description="Check your connection and try again."
                endContent={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    label="Retry"
                    onClick={() => void refetch()}
                  />
                }
              />
            ) : trashed.length === 0 ? (
              <Stack padding={4}>
                <EmptyState
                  title="No issues in the trash"
                  description="Issues moved to trash will appear here for 30 days."
                  headingLevel={3}
                />
              </Stack>
            ) : (
              <Section padding={3}>
                <Table aria-label="Trashed issues">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Key</TableHeaderCell>
                      <TableHeaderCell>Issue</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Priority</TableHeaderCell>
                      <TableHeaderCell>Last updated</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trashed.map((issue) => (
                      <TableRow
                        key={issue.id}
                        data-trashed-issue-id={issue.id}
                        data-trashed-identifier={issue.identifier}
                      >
                        <TableCell>
                          <Text as="span" type="supporting" color="secondary">
                            {issue.identifier}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Text type="body" weight="semibold" color="primary">
                            {issue.title}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Token label={issueStatusLabels[issue.status]} color="gray" size="sm" />
                        </TableCell>
                        <TableCell>
                          <PriorityBadge priority={issue.priority} />
                        </TableCell>
                        <TableCell>
                          <Text type="supporting" color="secondary">
                            <time
                              dateTime={issue.updatedAt}
                              title={formatFullDateTime(issue.updatedAt)}
                            >
                              {relativeTime(issue.updatedAt)}
                            </time>
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            label={`Restore ${issue.identifier}`}
                            icon={<Icon icon={RotateCcw} />}
                            variant="secondary"
                            size="sm"
                            isDisabled={restoringId !== undefined}
                            isLoading={restoringId === issue.id}
                            data-restore-button=""
                            onClick={() => void onRestore(issue.id, issue.identifier)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
            )}
          </Stack>

          <Stack gap={3}>
            <Heading level={2} color="inherit">
              Knowledge
            </Heading>
            {knowledgePending ? (
              <Text as="p" display="block" type="supporting" role="status">
                Loading trashed knowledge…
              </Text>
            ) : knowledgeError ? (
              <Banner
                status="error"
                role="alert"
                title="Could not load trashed knowledge"
                description="Check your connection and try again."
                endContent={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    label="Retry"
                    onClick={() => void refetchKnowledge()}
                  />
                }
              />
            ) : trashedKnowledge.length === 0 ? (
              <Stack padding={4}>
                <EmptyState
                  title="No knowledge in the trash"
                  description="Knowledge entries moved to trash will appear here for 30 days."
                  headingLevel={3}
                />
              </Stack>
            ) : (
              <Section padding={3}>
                <Table aria-label="Trashed knowledge">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Document</TableHeaderCell>
                      <TableHeaderCell>Last updated</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trashedKnowledge.map((entry) => (
                      <TableRow key={entry.id} data-trashed-knowledge-id={entry.id}>
                        <TableCell>
                          <Text type="body" weight="semibold" color="primary">
                            {entry.title}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Text type="supporting" color="secondary">
                            <time
                              dateTime={entry.updatedAt}
                              title={formatFullDateTime(entry.updatedAt)}
                            >
                              {relativeTime(entry.updatedAt)}
                            </time>
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            label={`Restore ${entry.title}`}
                            icon={<Icon icon={RotateCcw} />}
                            variant="secondary"
                            size="sm"
                            isDisabled={restoringId !== undefined}
                            isLoading={restoringId === entry.id}
                            data-restore-knowledge-button=""
                            onClick={() => void onRestoreKnowledge(entry.id, entry.title)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}
