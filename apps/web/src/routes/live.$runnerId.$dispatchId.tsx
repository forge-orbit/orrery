import { createFileRoute } from "@tanstack/react-router";
import { LiveStudio } from "../features/runners/index.ts";

export const Route = createFileRoute("/live/$runnerId/$dispatchId")({
  staticData: { fullHeightLayout: true },
  validateSearch: (search: Record<string, unknown>) => {
    const parsed: {
      issueId: string;
      workspaceId?: string | undefined;
      filter?: string | undefined;
      file?: string | undefined;
    } = {
      issueId: typeof search.issueId === "string" ? search.issueId : "",
    };
    if (typeof search.workspaceId === "string") parsed.workspaceId = search.workspaceId;
    if (typeof search.filter === "string") parsed.filter = search.filter;
    if (typeof search.file === "string") parsed.file = search.file;
    return parsed;
  },
  component: LiveStudioRoute,
});

function LiveStudioRoute() {
  const { runnerId, dispatchId } = Route.useParams();
  const { issueId, workspaceId, filter, file } = Route.useSearch();
  return (
    <LiveStudio
      key={`${runnerId}:${dispatchId}`}
      issueId={issueId}
      runnerId={runnerId}
      dispatchId={dispatchId}
      workspaceId={workspaceId}
      filter={filter}
      file={file}
    />
  );
}
