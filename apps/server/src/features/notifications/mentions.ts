const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const MENTION = /(?<![\w/.@+-])@([a-z0-9][a-z0-9-]{0,38})/gi;

/**
 * Extract the handles mentioned in a Markdown body for notification delivery.
 * Code blocks, inline code, links and email addresses are deliberately ignored
 * so that `@handle` inside them never produces a notification.
 */
export function extractMentionHandles(body: string): string[] {
  const plain = body
    .replace(FENCED_CODE, "")
    .replace(INLINE_CODE, "")
    .replace(MARKDOWN_LINK, "")
    .replace(EMAIL, "");
  const found = new Set<string>();
  for (const match of plain.matchAll(MENTION)) {
    const handle = match[1];
    if (handle !== undefined) found.add(handle.toLowerCase());
  }
  return [...found];
}

export function newlyAddedMentions(previousBody: string, nextBody: string): string[] {
  const before = new Set(extractMentionHandles(previousBody));
  return extractMentionHandles(nextBody).filter((handle) => !before.has(handle));
}
