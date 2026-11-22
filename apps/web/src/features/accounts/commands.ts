import {
  ChangePasswordResponse,
  LoginResponse,
  LogoutResponse,
  SessionResponse,
  SetupAdminResponse,
} from "@orrery/contract";
import type {
  ChangePasswordRequest,
  LoginRequest,
  SetupAdminRequest,
  UpdateProfileRequest,
} from "@orrery/contract";
import { deleteJson, patchJson, post, postJson, putForm } from "../../lib/api.ts";

export function createFirstAdministrator(input: SetupAdminRequest): Promise<SetupAdminResponse> {
  return postJson("/api/setup/admin", input, (value) => SetupAdminResponse.parse(value));
}

export function signIn(input: LoginRequest): Promise<LoginResponse> {
  return postJson("/api/auth/login", input, (value) => LoginResponse.parse(value));
}

export function signOut(): Promise<LogoutResponse> {
  return post("/api/auth/logout", (value) => LogoutResponse.parse(value));
}

export function updateProfile(input: UpdateProfileRequest): Promise<SessionResponse> {
  return patchJson("/api/account/profile", input, (value) => SessionResponse.parse(value));
}

export function uploadAvatar(file: File): Promise<SessionResponse> {
  const form = new FormData();
  form.set("file", file);
  return putForm("/api/account/avatar", form, (value) => SessionResponse.parse(value));
}

export function removeAvatar(): Promise<SessionResponse> {
  return deleteJson("/api/account/avatar", (value) => SessionResponse.parse(value));
}

export function changePassword(input: ChangePasswordRequest): Promise<ChangePasswordResponse> {
  return postJson("/api/account/password", input, (value) => ChangePasswordResponse.parse(value));
}
