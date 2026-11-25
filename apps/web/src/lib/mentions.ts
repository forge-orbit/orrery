import type { MentionActor, MentionAgent, MentionHuman } from "@orrery/contract";

export function findAtMention(text: string): { start: number; query: string } | null {
  const match = /(?:^|[\s(])@([a-zA-Z0-9-]*)$/.exec(text);
  if (match === null) return null;
  const start = text.lastIndexOf("@");
  if (start < 0) return null;
  return { start, query: match[1] ?? "" };
}

export function mentionToken(actor: MentionActor): string {
  return actor.type === "human" ? `@${actor.handle}` : `@${actor.slug}`;
}

export function actorLabel(actor: MentionActor): string {
  return actor.type === "human" ? (actor.displayName ?? actor.handle) : actor.name;
}

export function filterMentionCandidates(
  humans: readonly MentionHuman[],
  agents: readonly MentionAgent[],
  query: string,
): MentionActor[] {
  const q = query.trim().toLowerCase();
  const matches = (value: string) => q === "" || value.toLowerCase().includes(q);
  return [
    ...humans.filter(
      (human) => matches(human.handle) || matches(human.email) || matches(actorLabel(human)),
    ),
    ...agents.filter((agent) => matches(agent.slug) || matches(agent.name)),
  ].slice(0, 6);
}

/** Move the active suggestion, wrapping at either end of the list. */
export function nextMentionSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}
