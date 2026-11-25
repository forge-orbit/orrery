import { Stack } from "@astryxdesign/core/Stack";
import { Token } from "@astryxdesign/core/Token";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../../lib/Link.tsx";
import { issueDispatchesQuery } from "./queries.ts";

/** Compact "Open Live Studio" entry point rendered inside the Session inspector. */
export function LiveStudioLink({ issueId }: { issueId: string }) {
  const dispatches = useQuery(issueDispatchesQuery(issueId));
  const sorted = (dispatches.data?.dispatches ?? []).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const dispatch = sorted.find((entry) => entry.state !== "ended") ?? sorted[0];

  if (dispatch === undefined) return null;

  return (
    <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
      <Link
        to="/live/$runnerId/$dispatchId"
        params={{ runnerId: dispatch.runnerId, dispatchId: dispatch.id }}
        search={{ issueId, workspaceId: dispatch.workspaceId }}
        color="accent"
        weight="semibold"
        hasUnderline
        data-open-live-studio={dispatch.id}
      >
        Open Live Studio
      </Link>
      <Token label={`dispatch · ${dispatch.state}`} size="sm" color="blue" />
    </Stack>
  );
}
