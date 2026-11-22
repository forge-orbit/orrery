import { Problem, type Problem as ProblemDetails } from "@orrery/contract";

export class ApiProblemError extends Error {
  readonly code: string;
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.errors?.[0]?.detail ?? problem.detail ?? problem.title);
    this.name = "ApiProblemError";
    this.code = problem.code;
    this.status = problem.status;
    this.problem = problem;
  }
}

async function failure(res: Response): Promise<never> {
  const problem = Problem.safeParse(await res.json().catch(() => null));
  if (!problem.success) throw new Error(`Request failed (${res.status}).`);
  throw new ApiProblemError(problem.data);
}

export async function getJson<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

async function sendJson<T>(
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

export function postJson<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  return sendJson("POST", path, body, parse);
}

export async function putForm<T>(
  path: string,
  body: FormData,
  parse: (value: unknown) => T,
): Promise<T> {
  const res = await fetch(path, { method: "PUT", body });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

export function putJson<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  return sendJson("PUT", path, body, parse);
}

export async function post<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

export async function postNoContent(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res);
}

export function patchJson<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  return sendJson("PATCH", path, body, parse);
}

export async function deleteRequest(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) return failure(res);
}

export async function deleteJson<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}
