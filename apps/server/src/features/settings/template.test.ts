import { describe, expect, it } from "vitest";
import { ORRERY_LOGO_CID, ORRERY_LOGO_PNG, renderEmail } from "./template.ts";

describe("renderEmail", () => {
  it("renders the Orrery logo, heading, action button, code block, and escapes HTML", () => {
    const html = renderEmail({
      heading: 'Join "Core <Team>" & Co',
      paragraphs: ["Hello <script>alert(1)</script>"],
      action: { label: "Accept & Join", url: "https://orrery.example/invite?a=1&b=2" },
      code: { label: "Code", value: "abc-123" },
      callout: { label: "Question", body: "Use <b>bold</b>?", meta: "Fallback: yes" },
      footnote: "Expires in 24 hours.",
    });

    expect(html).toContain(`src="cid:${ORRERY_LOGO_CID}"`);
    expect(ORRERY_LOGO_PNG.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(html).toContain("Join &quot;Core &lt;Team&gt;&quot; &amp; Co");
    expect(html).toContain("Hello &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("https://orrery.example/invite?a=1&amp;b=2");
    expect(html).toContain("Accept &amp; Join");
    expect(html).toContain("abc-123");
    expect(html).toContain("Use &lt;b&gt;bold&lt;/b&gt;?");
    expect(html).toContain("Expires in 24 hours.");
  });
});
