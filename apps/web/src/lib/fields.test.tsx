import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CurrentPasswordField } from "./fields.tsx";

describe("CurrentPasswordField", () => {
  it("starts read-only and opts out of password-manager autofill", () => {
    const html = renderToStaticMarkup(
      <CurrentPasswordField
        id="current-password"
        label="Current password"
        value=""
        onChange={() => {}}
        required
      />,
    );

    expect(html).toContain('type="password"');
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toContain("readonly");
    expect(html).not.toMatch(/autocomplete="current-password"/i);
  });
});
