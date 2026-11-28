import { SessionResponse, SetupStatus } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

export const setupStatusQuery = queryOptions({
  queryKey: ["setup", "status"],
  queryFn: async () => SetupStatus.parse(await (await fetch("/api/setup/status")).json()),
});

export type Session =
  | { signedIn: false }
  | {
      signedIn: true;
      humanId: string;
      email: string;
      handle: string;
      displayName: string | null;
      emailVerified: boolean;
      avatarUrl: string | null;
    };

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async (): Promise<Session> => {
    const res = await fetch("/api/auth/session");

    if (res.status === 401) return { signedIn: false };
    if (!res.ok) throw new Error(`Session check failed (${res.status}).`);
    const account = SessionResponse.parse(await res.json());
    return {
      signedIn: true,
      humanId: account.humanId,
      email: account.email,
      handle: account.handle,
      displayName: account.displayName ?? null,
      emailVerified: account.emailVerified,
      avatarUrl: account.avatarUrl,
    };
  },
});
