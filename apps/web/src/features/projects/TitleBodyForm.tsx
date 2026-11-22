import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Stack } from "@astryxdesign/core/Stack";
import type { Issue } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { IssueMentionTextArea } from "./IssueMentionTextArea.tsx";

export interface TitleBodyFormProps {
  idPrefix: string;
  titleLabel: string;
  bodyLabel: string;
  bodyRows: number;
  submitLabel: string;
  fallbackError: string;
  initialTitle?: string;
  initialBody?: string;
  resetOnSuccess?: boolean;
  mentionIssues?: readonly Issue[];
  onSubmit: (values: { title: string; body: string }) => Promise<void>;
}

export function TitleBodyForm({
  idPrefix,
  titleLabel,
  bodyLabel,
  bodyRows,
  submitLabel,
  fallbackError,
  initialTitle = "",
  initialBody = "",
  resetOnSuccess = false,
  mentionIssues,
  onSubmit,
}: TitleBodyFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({ title, body });
      if (resetOnSuccess) {
        setTitle("");
        setBody("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <FormLayout>
        <TextField
          label={titleLabel}
          id={`${idPrefix}-title`}
          htmlName="title"
          value={title}
          onChange={setTitle}
          required
          maxLength={200}
          width="100%"
        />

        <IssueMentionTextArea
          label={bodyLabel}
          id={`${idPrefix}-body`}
          htmlName="body"
          value={body}
          onChange={setBody}
          rows={bodyRows}
          {...(mentionIssues !== undefined ? { issues: mentionIssues } : {})}
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Stack direction="horizontal" hAlign="start">
          <Button
            type="submit"
            isDisabled={submitting}
            isLoading={submitting}
            label={submitLabel}
            variant="primary"
          />
        </Stack>
      </FormLayout>
    </form>
  );
}
