import { Attachment } from "@orrery/contract";
import { postForm } from "../../lib/api.ts";

export { uploadAttachment };

function uploadAttachment(projectId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.set("file", file);
  return postForm(`/api/projects/${encodeURIComponent(projectId)}/attachments`, form, (value) =>
    Attachment.parse(value),
  );
}
