import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../features/accounts/index.ts";
import { MyWorkErrorState, MyWorkSections, myWorkQuery } from "../features/my-work/index.ts";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/my-work")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(myWorkQuery);
  },
  component: MyWorkPage,
  pendingComponent: MyWorkLoadingState,
  errorComponent: ({ error }) => <MyWorkErrorState error={error} />,
});

function MyWorkLoadingState() {
  return (
    <Stack as="main" gap={5} data-my-work-loading="">
      <PageHeader title="My work" />
      <Text as="p" display="block" type="supporting" role="status">
        Loading your work…
      </Text>
    </Stack>
  );
}

function MyWorkPage() {
  const work = useQuery(myWorkQuery);

  if (work.isPending) return <MyWorkLoadingState />;

  if (work.isError) {
    return <MyWorkErrorState error={work.error} onRetry={() => void work.refetch()} />;
  }

  return (
    <Stack as="main" gap={5} data-my-work-page="">
      <PageHeader
        title="My work"
        subtitle="Your assignments, live agent sessions, and questions across all your workspaces."
      />
      <MyWorkSections work={work.data} />
    </Stack>
  );
}
