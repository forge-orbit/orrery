import { Banner } from "@astryxdesign/core/Banner";
import { Stack } from "@astryxdesign/core/Stack";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HistoryList, installationHistoryQuery } from "../features/history/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/history/installation")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(installationHistoryQuery);
  },
  component: InstallationHistoryPage,
});

function InstallationHistoryPage() {
  const { data: events } = useSuspenseQuery(installationHistoryQuery);

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link key="home" to="/">
            Back to your workspaces
          </Link>,
        ]}
        title="Installation history"
      />
      {events === null ? (
        <Banner
          status="error"
          role="alert"
          title="Administrator access required"
          description="Installation history is available to system administrators only."
        />
      ) : (
        <HistoryList
          events={events}
          emptyMessage="No installation access events have been recorded yet."
        />
      )}
    </Stack>
  );
}
