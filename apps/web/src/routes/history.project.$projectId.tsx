import { Stack } from "@astryxdesign/core/Stack";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HistoryList, projectHistoryQuery } from "../features/history/index.ts";
import { projectQuery, ResourceLoadError } from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/history/project/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await context.queryClient.ensureQueryData(projectHistoryQuery(project.id));
  },
  component: ProjectHistoryPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="history" error={error} />,
});

function ProjectHistoryPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: events } = useSuspenseQuery(projectHistoryQuery(projectId));

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
            Back to {project.name}
          </Link>,
        ]}
        title="Project history"
        badge={project.name}
      />
      <HistoryList
        events={events}
        emptyMessage="No activity or access changes have been recorded in this project."
      />
    </Stack>
  );
}
