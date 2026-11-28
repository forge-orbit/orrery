import { CreateDispatchRequest, Dispatch } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { routes } from "../index.ts";
import { openApiDocument } from "../../platform/openapi.ts";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const schema = (name: string): unknown =>
  field(field(field(openApiDocument(routes), "components"), "schemas"), name);

const promptRef = (name: string): unknown => field(field(schema(name), "properties"), "prompt");

describe("generated OpenAPI Dispatch prompt schemas", () => {
  it("keeps the shared DispatchPrompt string-only and the response field nullable", () => {
    expect(schema("DispatchPrompt")).toEqual({ type: "string" });
    expect(schema("NullableDispatchPrompt")).toMatchObject({ type: ["string", "null"] });
    expect(promptRef("Dispatch")).toEqual({
      $ref: "#/components/schemas/NullableDispatchPrompt",
    });
    expect(promptRef("CreateDispatchRequest")).toEqual({
      $ref: "#/components/schemas/DispatchPrompt",
    });
  });

  it("advertises no null prompt on requests and still rejects one at runtime", () => {
    expect(CreateDispatchRequest.safeParse({ runnerId: "runner-1", prompt: null }).success).toBe(
      false,
    );
    expect(Dispatch.shape.prompt.safeParse(null).success).toBe(true);
  });
});

describe("generated OpenAPI label filters (#280)", () => {
  it("advertises the shared LabelFilter on auto-claim and ready-work", () => {
    expect(schema("LabelFilter")).toEqual({
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
    });
    expect(field(field(schema("AutoClaimRequest"), "properties"), "labels")).toEqual({
      $ref: "#/components/schemas/LabelFilter",
    });

    const readyWork = field(
      field(
        field(field(openApiDocument(routes), "paths"), "/api/projects/{projectId}/ready-work"),
        "get",
      ),
      "parameters",
    );
    const labels = list(readyWork).find((parameter) => field(parameter, "name") === "labels");
    expect(labels).toEqual({
      schema: { $ref: "#/components/schemas/LabelFilter" },
      required: false,
      name: "labels",
      in: "query",
    });
  });
});
