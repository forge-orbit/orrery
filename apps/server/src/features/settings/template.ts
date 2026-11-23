export const ORRERY_LOGO_CID = "orrery-logo";

// 144x128 (2x retina) PNG rendered from assets/orrery-mark.svg.
export const ORRERY_LOGO_PNG = Buffer.from(
  "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",
  "base64",
);

export interface EmailTemplate {
  preheader?: string;
  heading: string;
  paragraphs: readonly string[];
  action?: {
    label: string;
    url: string;
  };
  code?: {
    label: string;
    value: string;
  };
  callout?: {
    label?: string;
    body: string;
    meta?: string;
  };
  footnote: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderEmail(template: EmailTemplate): string {
  const preheader = template.preheader ?? template.paragraphs[0] ?? template.heading;

  const paragraphsHtml = template.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");

  const actionHtml =
    template.action === undefined
      ? ""
      : [
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 16px;">`,
          `<tr><td align="left" bgcolor="#F2561D" style="border-radius:8px;">`,
          `<a href="${escapeHtml(template.action.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;line-height:1;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(template.action.label)}</a>`,
          `</td></tr></table>`,
          `<p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:#6B7280;word-break:break-all;">Or open this link: <a href="${escapeHtml(template.action.url)}" style="color:#525866;text-decoration:underline;">${escapeHtml(template.action.url)}</a></p>`,
        ].join("");

  const codeHtml =
    template.code === undefined
      ? ""
      : [
          `<p style="margin:20px 0 8px;font-size:13px;font-weight:600;color:#525866;">${escapeHtml(template.code.label)}</p>`,
          `<div style="margin:0 0 20px;padding:12px 14px;background-color:#F4F5F7;border:1px solid #E2E5EB;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;line-height:1.5;color:#14161B;word-break:break-all;">${escapeHtml(template.code.value)}</div>`,
        ].join("");

  const calloutHtml =
    template.callout === undefined
      ? ""
      : [
          `<div style="margin:20px 0;padding:14px 16px;background-color:#FAFAFB;border:1px solid #E5E7EB;border-left:3px solid #F2561D;border-radius:8px;">`,
          template.callout.label === undefined
            ? ""
            : `<p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6B7280;">${escapeHtml(template.callout.label)}</p>`,
          `<p style="margin:0;font-size:15px;line-height:1.6;color:#14161B;white-space:pre-line;">${escapeHtml(template.callout.body)}</p>`,
          template.callout.meta === undefined
            ? ""
            : `<p style="margin:10px 0 0;font-size:13px;line-height:1.5;color:#525866;">${escapeHtml(template.callout.meta)}</p>`,
          `</div>`,
        ].join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(template.heading)}</title>`,
    "</head>",
    "<body style=\"margin:0;padding:0;background-color:#F6F7F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14161B;-webkit-font-smoothing:antialiased;\">",
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F6F7F9;padding:36px 16px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;">',
    '<tr><td style="padding:32px 32px 28px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">',
    "<tr>",
    `<td valign="middle" style="padding-right:10px;"><img src="cid:${ORRERY_LOGO_CID}" width="27" height="24" alt="Orrery" style="display:block;border:0;outline:none;text-decoration:none;"></td>`,
    '<td valign="middle" style="font-size:17px;font-weight:700;letter-spacing:-0.01em;color:#14161B;">Orrery</td>',
    "</tr>",
    "</table>",
    `<h1 style="margin:0 0 14px;font-size:20px;font-weight:700;line-height:1.3;letter-spacing:-0.01em;color:#14161B;">${escapeHtml(template.heading)}</h1>`,
    paragraphsHtml,
    actionHtml,
    calloutHtml,
    codeHtml,
    '<hr style="border:0;border-top:1px solid #E5E7EB;margin:24px 0 16px;">',
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#6B7280;">${escapeHtml(template.footnote)}</p>`,
    "</td></tr>",
    "</table>",
    '<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#7B8190;text-align:center;">Sent by Orrery</p>',
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("");
}
