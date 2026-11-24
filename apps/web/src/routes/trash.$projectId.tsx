import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
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
  PriorityBadge,
  projectActivityQuery,
  projectQuery,
  projectTrashQuery,
  readyWorkQuery,
  ResourceLoadError,
  restoreIssue,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import { formatFullDateTime, relativeTime } from "../lib/time.ts";

export const Route = createFileRoute("/trash/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    if (project.accessLevel === "manage") {
      await context.queryClient.ensureQueryData(projectTrashQuery(project.id));
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
        subtitle="Soft-deleted issues stay recoverable for 30 days."
      />
      {error !== undefined && (
        <Banner status="error" role="alert" title="Could not restore issue" description={error} />
      )}
      {!canManage ? (
        <Stack padding={4}>
          <EmptyState
            title="Manager access required"
            description="Only a project manager can view and restore trashed issues."
            headingLevel={2}
          />
        </Stack>
      ) : isPending ? (
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
            headingLevel={2}
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
                      <time dateTime={issue.updatedAt} title={formatFullDateTime(issue.updatedAt)}>
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
  );
}
