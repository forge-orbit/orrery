import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Link } from "../../lib/Link.tsx";
import { ApiProblemError } from "../../lib/api.ts";

type Resource = "project" | "board" | "issue" | "knowledge" | "workspace" | "history" | "trash";

const labels: Record<Resource, { title: string; noun: string }> = {
  project: { title: "Project", noun: "project" },
  board: { title: "Board", noun: "board" },
  issue: { title: "Issue", noun: "issue" },
  knowledge: { title: "Knowledge", noun: "knowledge entry" },
  workspace: { title: "Workspace", noun: "workspace" },
  history: { title: "History", noun: "history" },
  trash: { title: "Trash", noun: "trash" },
};

export function ResourceLoadError({ resource, error }: { resource: Resource; error: unknown }) {
  const { title, noun } = labels[resource];

  if (error instanceof ApiProblemError && error.status === 401) {
    return (
      <Stack gap={4}>
        <Heading level={1} color="inherit">
          {title}
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          Sign in to view this {noun}.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/signin">Sign in</Link>
        </Text>
      </Stack>
    );
  }

  if (error instanceof ApiProblemError && error.status === 404) {
    return (
      <Stack gap={4}>
        <Heading level={1} color="inherit">
          {title}
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          This {noun} does not exist or is not available to you.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/">Go to your workspaces</Link>
        </Text>
      </Stack>
    );
  }

  if (error instanceof ApiProblemError && error.status === 403) {
    return (
      <Stack gap={4}>
        <Heading level={1} color="inherit">
          {title}
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          You do not have permission to view this {noun}.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/">Go to your workspaces</Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={4}>
      <Heading level={1} color="inherit">
        {title}
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit" role="alert">
        Could not load this {noun}. Check your connection and try again.
      </Text>
    </Stack>
  );
}
