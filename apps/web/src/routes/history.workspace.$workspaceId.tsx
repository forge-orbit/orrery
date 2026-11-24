import { Stack } from "@astryxdesign/core/Stack";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HistoryList, workspaceHistoryQuery } from "../features/history/index.ts";
import { ResourceLoadError } from "../features/projects/index.ts";
import { workspaceQuery } from "../features/workspaces/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/history/workspace/$workspaceId")({
  loader: async ({ context, params }) => {
    const workspace = await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    await context.queryClient.ensureQueryData(workspaceHistoryQuery(workspace.id));
  },
  component: WorkspaceHistoryPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="history" error={error} />,
});

function WorkspaceHistoryPage() {
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: events } = useSuspenseQuery(workspaceHistoryQuery(workspaceId));

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link
            key="workspace"
            to="/workspaces/$workspaceId"
            params={{ workspaceId }}
            color="secondary"
            weight="medium"
          >
            Back to {workspace.name}
          </Link>,
        ]}
        title="Workspace access history"
        badge={workspace.name}
      />
      <HistoryList
        events={events}
        emptyMessage="No access changes have been recorded in this workspace."
      />
    </Stack>
  );
}
