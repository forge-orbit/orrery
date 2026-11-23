import { z } from "zod";
import { AvatarUrl } from "./auth.ts";
import { Email, Handle } from "./common.ts";

export const MentionHuman = z
  .object({
    type: z.literal("human"),
    id: z.string(),
    handle: Handle,
    displayName: z.string().nullable(),
    email: Email,
    avatarUrl: AvatarUrl.nullable(),
  })
  .meta({ id: "MentionHuman" });
export type MentionHuman = z.infer<typeof MentionHuman>;

export const MentionAgent = z
  .object({
    type: z.literal("agent"),
    id: z.string(),
    slug: Handle,
    name: z.string(),
    avatarUrl: AvatarUrl.nullable(),
  })
  .meta({ id: "MentionAgent" });
export type MentionAgent = z.infer<typeof MentionAgent>;

export const MentionActor = z.discriminatedUnion("type", [MentionHuman, MentionAgent]);
export type MentionActor = z.infer<typeof MentionActor>;

export const MentionCandidatesResponse = z
  .object({ humans: z.array(MentionHuman), agents: z.array(MentionAgent) })
  .meta({ id: "MentionCandidatesResponse" });
export type MentionCandidatesResponse = z.infer<typeof MentionCandidatesResponse>;
