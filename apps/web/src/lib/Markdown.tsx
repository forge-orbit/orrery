import { isAttachmentUrl } from "@orrery/contract";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { MentionActor } from "@orrery/contract";
import { useQuery } from "@tanstack/react-query";
import { createElement, type ReactNode, useId } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useResolvedAppearance } from "./appearance.tsx";
import { Link } from "./Link.tsx";

export interface IssueReference {
  id: string;
  number: number;
  identifier: string;
  title: string;
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdastNode[];
}

const SKIP_REF_PARENTS = new Set(["link", "linkReference", "code", "inlineCode", "definition"]);

function createIssueRefPlugin(issueRefs: readonly IssueReference[]) {
  const byNumber = new Map<number, IssueReference>();
  const byIdentifier = new Map<string, IssueReference>();
  for (const ref of issueRefs) {
    byNumber.set(ref.number, ref);
    byIdentifier.set(ref.identifier.toUpperCase(), ref);
  }
  const pattern = /(?<![\w/])(?:#(\d+)|([A-Z][A-Z0-9]{1,9}-\d+))\b/g;

  function transformChildren(parent: MdastNode) {
    if (!Array.isArray(parent.children) || SKIP_REF_PARENTS.has(parent.type)) return;
    const next: MdastNode[] = [];
    for (const child of parent.children) {
      if (child.type !== "text" || typeof child.value !== "string") {
        transformChildren(child);
        next.push(child);
        continue;
      }
      const text = child.value;
      pattern.lastIndex = 0;
      let cursor = 0;
      let matched = false;
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const raw = match[0];
        const numGroup = match[1];
        const keyGroup = match[2];
        const ref =
          numGroup !== undefined
            ? byNumber.get(Number(numGroup))
            : keyGroup !== undefined
              ? byIdentifier.get(keyGroup.toUpperCase())
              : undefined;
        if (ref === undefined) continue;
        matched = true;
        if (start > cursor) {
          next.push({ type: "text", value: text.slice(cursor, start) });
        }
        next.push({
          type: "link",
          url: `/issues/${ref.id}`,
          title: `${ref.identifier}: ${ref.title}`,
          children: [{ type: "text", value: raw }],
        });
        cursor = start + raw.length;
      }
      if (!matched) {
        next.push(child);
      } else if (cursor < text.length) {
        next.push({ type: "text", value: text.slice(cursor) });
      }
    }
    parent.children = next;
  }

  return () => (tree: MdastNode) => {
    transformChildren(tree);
  };
}

const SKIP_MENTION_PARENTS = new Set(["link", "linkReference", "code", "inlineCode", "definition"]);
const MENTION_PATTERN = /(?<![\w/.@+-])@([a-z0-9][a-z0-9-]{0,38})/gi;

export const mentionUrl = (actor: MentionActor): string =>
  `/mentions/${actor.type}/${encodeURIComponent(actor.id)}`;

function createMentionPlugin(actors: readonly MentionActor[]) {
  const byToken = new Map<string, MentionActor>();
  for (const actor of actors) {
    byToken.set(
      actor.type === "human" ? `@${actor.handle.toLowerCase()}` : `@${actor.slug.toLowerCase()}`,
      actor,
    );
  }

  function transformChildren(parent: MdastNode) {
    if (!Array.isArray(parent.children) || SKIP_MENTION_PARENTS.has(parent.type)) return;
    const next: MdastNode[] = [];
    for (const child of parent.children) {
      if (child.type !== "text" || typeof child.value !== "string") {
        transformChildren(child);
        next.push(child);
        continue;
      }
      const text = child.value;
      MENTION_PATTERN.lastIndex = 0;
      let cursor = 0;
      let matched = false;
      for (const match of text.matchAll(MENTION_PATTERN)) {
        const start = match.index;
        const raw = match[0];
        const actor = byToken.get(raw.toLowerCase());
        if (actor === undefined) continue;
        matched = true;
        if (start > cursor) next.push({ type: "text", value: text.slice(cursor, start) });
        const label = actor.type === "human" ? (actor.displayName ?? actor.handle) : actor.name;
        next.push({
          type: "link",
          url: mentionUrl(actor),
          title: `${label} — ${actor.type === "agent" ? "Agent" : "Human"}`,
          children: [{ type: "text", value: raw }],
        });
        cursor = start + raw.length;
      }
      if (!matched) next.push(child);
      else if (cursor < text.length) next.push({ type: "text", value: text.slice(cursor) });
    }
    parent.children = next;
  }

  return () => (tree: MdastNode) => {
    transformChildren(tree);
  };
}

function safeUrl(url: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control characters from untrusted URLs.
  const value = url.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  const colon = value.indexOf(":");
  const boundaries = [value.indexOf("/"), value.indexOf("?"), value.indexOf("#")].filter(
    (index) => index >= 0,
  );
  const firstBoundary =
    boundaries.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...boundaries);

  if (colon >= 0 && colon < firstBoundary) {
    return /^(https?|mailto|tel):/i.test(value) ? value : "";
  }
  return value;
}

let initializedTheme: "light" | "dark" | null = null;

function diagramId(source: string, instanceId: string): string {
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) | 0;
  }
  const safeSuffix = instanceId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `orrery-mermaid-${Math.abs(hash).toString(36)}-${safeSuffix}`;
}

async function renderMermaid(
  source: string,
  scheme: "light" | "dark",
  instanceId: string,
): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  if (initializedTheme !== scheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: scheme === "dark" ? "dark" : "neutral",
    });
    initializedTheme = scheme;
  }
  const { svg } = await mermaid.render(diagramId(source, instanceId), source);
  return svg;
}

function MermaidDiagram({ source }: { source: string }) {
  const scheme = useResolvedAppearance();
  const instanceId = useId();
  const result = useQuery({
    queryKey: ["mermaid-diagram", scheme, instanceId, source],
    queryFn: () => renderMermaid(source, scheme, instanceId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
  });

  if (result.isPending) {
    return (
      <Text as="p" display="block" type="supporting" color="secondary" data-mermaid-pending>
        Rendering diagram…
      </Text>
    );
  }
  if (result.isError || typeof result.data !== "string") {
    return <pre data-mermaid-error>{source}</pre>;
  }
  return (
    <figure
      data-mermaid
      role="img"
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={{ __html: result.data }}
    />
  );
}

const components: Components = {
  h1({ children }) {
    return (
      <Heading level={2} color="inherit">
        {children}
      </Heading>
    );
  },
  h2({ children }) {
    return (
      <Heading level={3} color="inherit">
        {children}
      </Heading>
    );
  },
  h3({ children }) {
    return (
      <Heading level={4} color="inherit">
        {children}
      </Heading>
    );
  },
  h4({ children }) {
    return (
      <Heading level={5} color="inherit">
        {children}
      </Heading>
    );
  },
  p({ children }) {
    return (
      <Text as="p" display="block" type="body" color="inherit">
        {children}
      </Text>
    );
  },
  blockquote({ children }) {
    return (
      <Card variant="muted" padding={3}>
        <Stack gap={1.5}>{children}</Stack>
      </Card>
    );
  },
  hr() {
    return <Divider />;
  },
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
  table({ children, node: _node, ...props }) {
    return <Stack isScrollable>{createElement("table", props, children)}</Stack>;
  },
  code({ className, children, node: _node }) {
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    const text = typeof children === "string" ? children : "";
    if (language === "mermaid") {
      return <MermaidDiagram source={text.replace(/\n$/, "")} />;
    }
    if (language !== undefined || text.endsWith("\n")) {
      return (
        <Stack data-code-block="">
          <CodeBlock
            code={text.replace(/\n$/, "")}
            language={language ?? "plaintext"}
            hasLanguageLabel={language !== undefined}
            width="100%"
          />
        </Stack>
      );
    }
    return <Code size="inherit">{children}</Code>;
  },
  a({ href, title, children, node: _node, ...props }) {
    if (!href) {
      return (
        <Text as="span" type="inherit" color="secondary">
          {children}
        </Text>
      );
    }
    const mentionMatch = /^\/mentions\/(human|agent)\/([^/]+)$/.exec(href);
    if (mentionMatch?.[1] !== undefined && mentionMatch[2] !== undefined) {
      const kind = mentionMatch[1];
      const label =
        typeof children === "string"
          ? children
          : Array.isArray(children)
            ? children.filter((part) => typeof part === "string").join("")
            : "";
      return (
        <Tooltip content={title ?? label}>
          <Token
            label={label}
            color={kind === "agent" ? "orange" : "blue"}
            size="sm"
            data-mention=""
            data-mention-kind={kind}
          />
        </Tooltip>
      );
    }
    const issueMatch = /^\/issues\/([0-9a-f-]+)$/i.exec(href);
    if (issueMatch?.[1] !== undefined) {
      return (
        <Link to="/issues/$issueId" params={{ issueId: issueMatch[1] }}>
          <Text as="span" type="inherit" color="inherit">
            {children}
          </Text>
        </Link>
      );
    }
    return createElement(
      "a",
      { href, title, target: "_blank", rel: "noopener noreferrer", ...props },
      children,
    );
  },
  img({ alt, src }) {
    // Only Orrery's own authenticated attachment URLs become <img> elements;
    // external hotlinks stay plain text so Markdown cannot place tracking pixels.
    if (typeof src === "string" && isAttachmentUrl(src)) {
      return createElement("img", {
        src,
        alt: alt ?? "",
        loading: "lazy",
        decoding: "async",
        "data-orrery-attachment": "true",
      });
    }
    return (
      <Text as="span" type="inherit" color="secondary">
        {alt === undefined || alt === "" ? "[image]" : `[image: ${alt}]`}
      </Text>
    );
  },
};

export function Markdown({
  children,
  issueRefs,
  mentionActors,
}: {
  children: string;
  issueRefs?: readonly IssueReference[];
  mentionActors?: readonly MentionActor[];
}) {
  const plugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
  if (issueRefs !== undefined && issueRefs.length > 0) {
    plugins.push(createIssueRefPlugin(issueRefs));
  }
  if (mentionActors !== undefined && mentionActors.length > 0) {
    plugins.push(createMentionPlugin(mentionActors));
  }
  return (
    <Stack gap={2} data-markdown="">
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={safeUrl}>
        {children}
      </ReactMarkdown>
    </Stack>
  );
}
