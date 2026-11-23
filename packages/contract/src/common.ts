import { z } from "zod";



export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email()).meta({ id: "Email" });
export type Email = z.infer<typeof Email>;

export const Handle = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/,
    "Use 2-39 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
  )
  .meta({ id: "Handle" });
export type Handle = z.infer<typeof Handle>;


export const NewPassword = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(256)
  .meta({ id: "NewPassword" });
export type NewPassword = z.infer<typeof NewPassword>;





export const LoginEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(1024)
  .meta({ id: "LoginEmail" });
export type LoginEmail = z.infer<typeof LoginEmail>;

export const LoginPassword = z
  .string()
  .min(1)
  .max(1024)
  .meta({ id: "LoginPassword" });
export type LoginPassword = z.infer<typeof LoginPassword>;


export const WorkspaceKind = z
  .enum(["personal", "shared"])
  .meta({ id: "WorkspaceKind" });
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;



export const Timestamp = z.iso.datetime().meta({ id: "Timestamp" });
export type Timestamp = z.infer<typeof Timestamp>;





export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export const ProblemCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .meta({ id: "ProblemCode" });
export type ProblemCode = z.infer<typeof ProblemCode>;



export const problemType = (code: ProblemCode) => `urn:orrery:problem:${code}`;



export const FieldError = z
  .object({ pointer: z.string(), detail: z.string() })
  .meta({ id: "FieldError" });
export type FieldError = z.infer<typeof FieldError>;

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    code: ProblemCode,
    errors: z.array(FieldError).optional(),
  })
  .meta({ id: "Problem" });
export type Problem = z.infer<typeof Problem>;
