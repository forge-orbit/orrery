import { z } from "zod";
import { Email, Handle, LoginEmail, LoginPassword, NewPassword } from "./common.ts";





export const LoginRequest = z
  .object({
    email: LoginEmail,
    password: LoginPassword,
  })
  .meta({ id: "LoginRequest" });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z
  .object({
    email: Email,
  })
  .meta({ id: "LoginResponse" });
export type LoginResponse = z.infer<typeof LoginResponse>;

export const DisplayName = z
  .string()
  .trim()
  .min(1, "Display name must not be blank.")
  .max(120, "Display name must be 120 characters or fewer.")
  .meta({ id: "DisplayName" });
export type DisplayName = z.infer<typeof DisplayName>;




export const AvatarUrl = z
  .string()
  .regex(/^\/api\/humans\/[^/]+\/avatar(\?v=[^/]+)?$/)
  .meta({ id: "AvatarUrl" });
export type AvatarUrl = z.infer<typeof AvatarUrl>;

export const SessionResponse = z
  .object({
    humanId: z.string(),
    email: Email,
    handle: Handle,
    displayName: z.string().nullable().optional(),
    emailVerified: z.boolean(),
    avatarUrl: AvatarUrl.nullable(),
  })
  .meta({ id: "SessionResponse" });
export type SessionResponse = z.infer<typeof SessionResponse>;

export const UpdateProfileRequest = z
  .object({
    displayName: DisplayName.nullable(),
    handle: Handle.optional(),
  })
  .meta({ id: "UpdateProfileRequest" });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const ChangePasswordRequest = z
  .object({
    currentPassword: LoginPassword,
    newPassword: NewPassword,
  })
  .meta({ id: "ChangePasswordRequest" });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const ChangePasswordResponse = z
  .object({
    changed: z.literal(true),
  })
  .meta({ id: "ChangePasswordResponse" });
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponse>;

export const LogoutResponse = z
  .object({
    signedOut: z.literal(true),
  })
  .meta({ id: "LogoutResponse" });
export type LogoutResponse = z.infer<typeof LogoutResponse>;
