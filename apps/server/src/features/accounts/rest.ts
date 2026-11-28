import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ChangePasswordRequest,
  ChangePasswordResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  SessionResponse,
  SetupAdminRequest,
  SetupAdminResponse,
  SetupStatus,
  UpdateProfileRequest,
} from "@orrery/contract";
import { getCookie, setCookie } from "hono/cookie";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import {
  AccountsError,
  type AccountsErrorKind,
  type AccountsService,
  type SessionAccount,
  deriveHandleFromEmail,
  rejectLogin,
} from "./service.ts";

const setupStatus = createRoute({
  method: "get",
  path: "/api/setup/status",
  summary: "Whether initial setup (creating the first administrator) is complete",
  responses: {
    200: { description: "Setup status", content: { "application/json": { schema: SetupStatus } } },
  },
});

const setupAdmin = createRoute({
  method: "post",
  path: "/api/setup/admin",
  summary: "Create the first system administrator and close setup",
  description:
    "Requires the deployment-supplied bootstrap secret. Creates the administrator, its personal workspace, and the record that closes bootstrap, in one transaction. Exactly one attempt can ever succeed.",
  request: {
    body: { required: true, content: { "application/json": { schema: SetupAdminRequest } } },
  },
  responses: {
    201: {
      description: "Administrator created; setup is closed",
      content: { "application/json": { schema: SetupAdminResponse } },
    },
    400: problem("Invalid secret, email, or password"),
    401: problem("The setup secret is wrong"),
    403: problem("No setup secret is configured on this installation"),
    409: problem("Setup is already complete"),
  },
});

const login = createRoute({
  method: "post",
  path: "/api/auth/login",
  summary: "Sign in with email and password",
  description:
    "Accepts any non-empty email string and password by shape, and checks them against what is stored; wrong, unknown, or malformed credentials all answer the same 401. On success, sets the session cookie.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginRequest } } },
  },
  responses: {
    200: {
      description: "Signed in; the session cookie is set",
      content: { "application/json": { schema: LoginResponse } },
    },
    400: problem("The request body is not JSON"),
    401: problem("Wrong, unknown, or malformed email or password"),
  },
});

const logout = createRoute({
  method: "post",
  path: "/api/auth/logout",
  summary: "Sign out and revoke the current browser session",
  responses: {
    200: {
      description: "Signed out; the session cookie is cleared",
      content: { "application/json": { schema: LogoutResponse } },
    },
  },
});

const session = createRoute({
  method: "get",
  path: "/api/auth/session",
  summary: "The account behind the browser's session cookie",
  responses: {
    200: { description: "Signed in", content: { "application/json": { schema: SessionResponse } } },
    401: problem("No valid session"),
  },
});

const updateProfile = createRoute({
  method: "patch",
  path: "/api/account/profile",
  summary: "Update the signed-in account's profile",
  request: {
    body: { required: true, content: { "application/json": { schema: UpdateProfileRequest } } },
  },
  responses: {
    200: {
      description: "Updated account profile",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: problem("Invalid profile fields"),
    401: problem("No valid session"),
    403: problem("Setup is not available"),
    409: problem("Handle already in use"),
  },
});

const changePassword = createRoute({
  method: "post",
  path: "/api/account/password",
  summary: "Change the signed-in account's password",
  description:
    "Verifies the current password, updates the password hash, and revokes all other browser sessions while keeping the current session active.",
  request: {
    body: { required: true, content: { "application/json": { schema: ChangePasswordRequest } } },
  },
  responses: {
    200: {
      description: "Password changed; other browser sessions revoked",
      content: { "application/json": { schema: ChangePasswordResponse } },
    },
    400: problem("Invalid password input"),
    401: problem("No valid session or current password is incorrect"),
  },
});

export const routes = [
  setupStatus,
  setupAdmin,
  login,
  logout,
  session,
  updateProfile,
  changePassword,
];

const SESSION_COOKIE = "orrery_session";
const fixedCookieAttributes = { httpOnly: true, sameSite: "Lax", path: "/" } as const;

const statusFor = {
  setup_unavailable: 403,
  invalid_secret: 401,
  setup_complete: 409,
  invalid_credentials: 401,
  invalid_current_password: 401,
  handle_taken: 409,
} as const satisfies Record<AccountsErrorKind, number>;

const failure = (c: Context, error: AccountsError) =>
  problemResponse(c, { status: statusFor[error.kind], code: error.kind, title: error.message });

export function toSessionResponse(
  account: Pick<
    SessionAccount,
    "humanId" | "email" | "handle" | "displayName" | "emailVerifiedAt" | "avatarUrl"
  >,
  overrides?: { avatarUrl?: string | null },
) {
  return {
    humanId: account.humanId,
    email: account.email,
    handle: account.handle ?? deriveHandleFromEmail(account.email),
    displayName: account.displayName ?? null,
    emailVerified: account.emailVerifiedAt !== null,
    avatarUrl:
      overrides?.avatarUrl !== undefined ? overrides.avatarUrl : (account.avatarUrl ?? null),
  };
}

export function createAccountsRest(service: AccountsService) {
  const policy = service.sessionPolicy();

  const readSession = createSessionReader(service);

  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(setupStatus, async (c) => c.json(await service.setupStatus(), 200));

  app.openapi(setupAdmin, async (c) => {
    try {
      return c.json(await service.setupAdmin(c.req.valid("json")), 201);
    } catch (error) {
      if (error instanceof AccountsError && error.kind !== "invalid_credentials") {
        return failure(c, error);
      }
      throw error;
    }
  });

  app.openapi(
    login,
    async (c) => {
      try {
        const { token, email } = await service.login(c.req.valid("json"));
        setCookie(c, SESSION_COOKIE, token, {
          ...fixedCookieAttributes,
          secure: policy.secure,
          maxAge: policy.maxAgeSeconds,
        });
        return c.json({ email }, 200);
      } catch (error) {
        if (error instanceof AccountsError && error.kind === "invalid_credentials") {
          return problemResponse(c, {
            status: statusFor.invalid_credentials,
            code: error.kind,
            title: error.message,
          });
        }
        throw error;
      }
    },

    (result, c) => {
      if (result.success) return undefined;
      const rejected = rejectLogin();
      return problemResponse(c, {
        status: statusFor.invalid_credentials,
        code: rejected.kind,
        title: rejected.message,
      });
    },
  );

  app.openapi(logout, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) {
      await service.logout(token);
    }
    setCookie(c, SESSION_COOKIE, "", {
      ...fixedCookieAttributes,
      secure: policy.secure,
      maxAge: 0,
    });
    return c.json({ signedOut: true as const }, 200);
  });

  app.openapi(session, async (c) => {
    const account = await readSession(c);
    if (account === null) {
      return problemResponse(c, { status: 401, code: "not_signed_in", title: "Not signed in." });
    }

    return c.json(toSessionResponse(account), 200);
  });

  app.openapi(updateProfile, async (c) => {
    const account = await readSession(c);
    if (account === null) {
      return problemResponse(c, { status: 401, code: "not_signed_in", title: "Not signed in." });
    }
    try {
      const updated = await service.updateProfile(account.humanId, c.req.valid("json"));
      return c.json(toSessionResponse(updated), 200);
    } catch (error) {
      if (error instanceof AccountsError) return failure(c, error);
      throw error;
    }
  });

  app.openapi(changePassword, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const account = token === undefined ? null : await service.session(token);
    if (token === undefined || account === null) {
      return problemResponse(c, { status: 401, code: "not_signed_in", title: "Not signed in." });
    }
    try {
      await service.changePassword(account.humanId, token, c.req.valid("json"));
      return c.json({ changed: true as const }, 200);
    } catch (error) {
      if (error instanceof AccountsError && error.kind === "invalid_current_password") {
        return problemResponse(c, {
          status: statusFor.invalid_current_password,
          code: error.kind,
          title: error.message,
        });
      }
      throw error;
    }
  });

  return app;
}

export type SessionReader = (c: Context) => Promise<SessionAccount | null>;

export function createSessionReader(service: AccountsService): SessionReader {
  return async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    return token === undefined ? null : service.session(token);
  };
}
