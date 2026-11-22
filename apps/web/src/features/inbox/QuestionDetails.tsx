import { Divider } from "@astryxdesign/core/Divider";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { Question } from "@orrery/contract";
import { formatDateTime, formatFullDateTime, relativeCountdown } from "../../lib/time.ts";

const statusMeta: Record<
  Question["status"],
  { label: string; color: "orange" | "green" | "gray" }
> = {
  open: { label: "Needs input", color: "orange" },
  paused: { label: "Paused", color: "orange" },
  answered: { label: "Answered", color: "green" },
  fallback_used: { label: "Fallback used", color: "gray" },
};

export function isPendingQuestion(question: Question) {
  return question.status === "open" || question.status === "paused";
}

export function QuestionDetails({
  question,
  nested = false,
}: {
  question: Question;
  nested?: boolean;
}) {
  const deadline = question.responseDeadlineAt;
  const status = statusMeta[question.status];

  const details = (
    <Stack gap={2}>
      <Stack gap={0.5}>
        <Text as="span" type="supporting" weight="semibold" color="secondary">
          {question.authorizedFallback === null ? "Proposed fallback" : "Fallback used"}
        </Text>
        <Text as="p" display="block" type="body" color="primary">
          {question.authorizedFallback ?? question.proposedFallback}
        </Text>
      </Stack>
      {question.answer !== null && (
        <Stack gap={0.5}>
          <Text as="span" type="supporting" weight="semibold" color="secondary">
            Answer
          </Text>
          <Text as="p" display="block" type="body" color="primary" data-question-answer="">
            {question.answer}
          </Text>
        </Stack>
      )}
      {question.followUp !== null && (
        <Stack gap={0.5}>
          <Text as="span" type="supporting" weight="semibold" color="secondary">
            Follow-up
          </Text>
          <Text as="p" display="block" type="body" color="primary" data-question-follow-up="">
            {question.followUp}
          </Text>
        </Stack>
      )}
    </Stack>
  );

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={1.5} vAlign="center" justify="between" wrap="wrap">
        <Token
          label={status.label}
          color={status.color}
          size="sm"
          data-question-status={question.status}
        />
        <Text type="supporting" color="secondary">
          {question.status === "open" ? "Due" : "Deadline"}{" "}
          <time dateTime={deadline} title={formatFullDateTime(deadline)}>
            {formatDateTime(deadline)}
            {isPendingQuestion(question) ? ` (${relativeCountdown(deadline)})` : ""}
          </time>
        </Text>
      </Stack>
      <Text
        as="p"
        display="block"
        type="body"
        color="primary"
        weight="semibold"
        data-question-text=""
      >
        {question.question}
      </Text>
      {nested ? (
        <>
          <Divider />
          {details}
        </>
      ) : (
        <Section variant="muted" padding={3}>
          {details}
        </Section>
      )}
    </Stack>
  );
}
