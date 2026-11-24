import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import type { Feature } from "./feature.ts";
import { errorSummary } from "./errors.ts";
import type { Logger } from "./log.ts";
import { createMcpApp } from "./mcp.ts";
import { codeForStatus, problemResponse } from "./problem.ts";

/**
 * Prefer the matched route template (e.g. `/api/runners/device-codes/:userCode`)
 * over the raw URL path so path parameters that carry short-lived codes or tokens
 * are never written to stdout logs.
 */
function loggedPath(c: Context): string {
  for (let i = c.req.matchedRoutes.length - 1; i >= 0; i -= 1) {
    const route = c.req.matchedRoutes[i];
    if (route !== undefined && !route.path.endsWith("*")) return route.path;
  }
  return c.req.path;
}

export interface AppOptions {
  features: readonly Feature[];
  publicUrl: string;
  log: Logger;
  webDist?: string | undefined;
}

export function createApp({ features, publicUrl, log, webDist }: AppOptions) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      if (error.res !== undefined) return error.getResponse();
      return problemResponse(c, {
        status: error.status,
        code: codeForStatus(error.status),
        title: error.message || "The request could not be handled.",
      });
    }
    log.error("unhandled error", {
      ...errorSummary(error),
      method: c.req.method,
      path: loggedPath(c),
    });
    return problemResponse(c, {
      status: 500,
      code: "internal_error",
      title: "Internal server error.",
    });
  });

  app.notFound((c) => problemResponse(c, { status: 404, code: "not_found", title: "Not found." }));

  app.use("*", async (c, next) => {
    await next();
    log.info("request", { method: c.req.method, path: loggedPath(c), status: c.res.status });
  });

  for (const feature of features) if (feature.rest) app.route("/", feature.rest);
  app.route("/mcp", createMcpApp(features, publicUrl));

  if (webDist) {
    app.use("/assets/*", compress());
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) {
        c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
      }
    });
    app.use("/*", serveStatic({ root: webDist }));

    const index = readFile(join(webDist, "index.html"), "utf8");
    app.get("*", async (c) => c.html(await index));
  }

  return app;
}
