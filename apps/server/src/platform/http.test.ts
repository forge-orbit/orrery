import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./db.ts";
import type { Feature } from "./feature.ts";
import { createApp } from "./http.ts";
import { createLogger, type Logger } from "./log.ts";

const wrapped = createRoute({
  method: "get",
  path: "/wrapped",
  responses: { 200: { description: "Never reached" } },
});

const wrappedErrorFeature: Feature = {
  name: "wrappedError",
  rest: new OpenAPIHono().openapi(wrapped, () => {
    throw new Error("Failed query: insert into humans params: the-password-hash", {
      cause: new Error('violates check constraint "humans_email_normalized"'),
    });
  }),
};

class PostgresShapedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresError";
    this.code = code;
  }
}

const quoting = createRoute({
  method: "get",
  path: "/quoting",
  responses: { 200: { description: "Never reached" } },
});

const quotingErrorFeature: Feature = {
  name: "quotingError",
  rest: new OpenAPIHono().openapi(quoting, () => {
    throw new PostgresShapedError(
      "22P02",
      'invalid input syntax for type uuid: "the-value-that-must-not-leak"',
    );
  }),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const unhandledErrorLines = (lines: string[]) =>
  lines.flatMap((line) => {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) && entry.msg === "unhandled error" ? [entry] : [];
  });

const boom = createRoute({
  method: "get",
  path: "/boom",
  responses: { 200: { description: "Never reached" } },
});

const throwingFeature: Feature = {
  name: "throwing",
  rest: new OpenAPIHono().openapi(boom, () => {
    throw new Error("boom from the route");
  }),
};

const refused = createRoute({
  method: "get",
  path: "/refused",
  responses: { 415: { description: "The route said no" } },
});

const httpExceptionFeature: Feature = {
  name: "refused",
  rest: new OpenAPIHono().openapi(refused, () => {
    throw new HTTPException(415, { message: "Unsupported Media Type" });
  }),
};

const database = createDb("postgres://unused@127.0.0.1:1/unused");
afterAll(() => void database.sql.end());

describe("createApp error handling", () => {
  it("maps an unhandled error to a 500 Problem and logs one JSON line", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log = createLogger("info");
      const app = createApp({ features: [throwingFeature], publicUrl: "http://orrery.test", log });
      const res = await app.request("/boom");
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toEqual({
        type: "urn:orrery:problem:internal_error",
        title: "Internal server error.",
        status: 500,
        code: "internal_error",
      });

      const unhandled = unhandledErrorLines(lines);
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]).toMatchObject({
        error: "Error",
        message: "boom from the route",
        method: "GET",
        path: "/boom",
      });

      expect(Object.keys(unhandled[0] ?? {}).toSorted()).toEqual(
        ["time", "level", "msg", "error", "message", "method", "path"].toSorted(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("lets an HTTPException's own response through, without logging an error", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log: Logger = createLogger("info");
      const app = createApp({
        features: [httpExceptionFeature],
        publicUrl: "http://orrery.test",
        log,
      });
      const res = await app.request("/refused");
      expect(res.status).toBe(415);
      expect(lines.filter((line) => line.includes("unhandled error"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the wrapped error's cause, never the wrapper's parameters", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log: Logger = createLogger("info");
      const app = createApp({
        features: [wrappedErrorFeature],
        publicUrl: "http://orrery.test",
        log,
      });
      const res = await app.request("/wrapped");
      expect(res.status).toBe(500);

      const unhandled = unhandledErrorLines(lines);
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]).toMatchObject({
        error: "Error",
        message: 'violates check constraint "humans_email_normalized"',
      });

      expect(lines.join("\n")).not.toContain("the-password-hash");
    } finally {
      spy.mockRestore();
    }
  });

  it("logs a database error's name and SQLSTATE, never its message", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log: Logger = createLogger("info");
      const app = createApp({
        features: [quotingErrorFeature],
        publicUrl: "http://orrery.test",
        log,
      });
      const res = await app.request("/quoting");
      expect(res.status).toBe(500);

      const unhandled = unhandledErrorLines(lines);
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]).toMatchObject({ error: "PostgresError", code: "22P02" });

      expect(Object.keys(unhandled[0] ?? {}).toSorted()).toEqual(
        ["time", "level", "msg", "error", "code", "method", "path"].toSorted(),
      );
      expect(lines.join("\n")).not.toContain("the-value-that-must-not-leak");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a request body that is not JSON", () => {
  const echo = createRoute({
    method: "post",
    path: "/echo",
    request: { body: { content: { "application/json": { schema: z.object({}) } } } },
    responses: { 200: { description: "Echoed" } },
  });
  const echoFeature: Feature = {
    name: "echo",
    rest: new OpenAPIHono().openapi(echo, (c) => c.json({}, 200)),
  };

  it("answers 400 with a Problem, like every other error", async () => {
    const app = createApp({
      features: [echoFeature],
      publicUrl: "http://orrery.test",
      log: createLogger("error"),
    });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 400, code: "bad_request" });
  });

  it("answers an unknown route with a not_found Problem", async () => {
    const app = createApp({
      features: [],
      publicUrl: "http://orrery.test",
      log: createLogger("error"),
    });
    const res = await app.request("/api/nothing-here", { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 404, code: "not_found" });
  });

  it("logs the matched route template instead of raw path parameter values", async () => {
    const deviceRoute = createRoute({
      method: "get",
      path: "/api/device-codes/{userCode}",
      request: { params: z.object({ userCode: z.string() }) },
      responses: { 200: { description: "OK" } },
    });
    const deviceFeature: Feature = {
      name: "device",
      rest: new OpenAPIHono().openapi(deviceRoute, (c) => c.json({ ok: true }, 200)),
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const app = createApp({
        features: [deviceFeature],
        publicUrl: "http://orrery.test",
        log: createLogger("info"),
      });
      const res = await app.request("/api/device-codes/SECRET-CODE-9999");
      expect(res.status).toBe(200);
      expect(lines.join("\n")).not.toContain("SECRET-CODE-9999");
      expect(lines.join("\n")).toContain("/api/device-codes/:userCode");
    } finally {
      spy.mockRestore();
    }
  });
});
