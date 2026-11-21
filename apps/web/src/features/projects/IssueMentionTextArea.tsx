import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Issue } from "@orrery/contract";
import { useState } from "react";
import { TextAreaField } from "../../lib/fields.tsx";
import { issueStatusLabels } from "./issue-status.ts";

function findHashMention(text: string): { start: number; query: string } | null {
  const match = /(?:^|[\s(])#([a-zA-Z0-9-]*)$/.exec(text);
  if (match === null) return null;
  const query = match[1] ?? "";
  const hashIndex = text.lastIndexOf("#");
  if (hashIndex < 0) return null;
  return { start: hashIndex, query };
}

export interface IssueMentionTextAreaProps {
  label: string;
  id: string;
  htmlName: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  required?: boolean;
  placeholder?: string;
  issues?: readonly Issue[];
}

const EMPTY_ISSUES: readonly Issue[] = [];

export function IssueMentionTextArea({
  label,
  id,
  htmlName,
  value,
  onChange,
  rows,
  required,
  placeholder,
  issues = EMPTY_ISSUES,
}: IssueMentionTextAreaProps) {
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const mention = issues.length > 0 ? findHashMention(value) : null;
  const showMenu = mention !== null && dismissedAt !== mention.start;
  const matches = showMenu
    ? issues
        .filter((candidate) => {
          const q = mention.query.trim().toLowerCase();
          if (q === "") return true;
          return (
            String(candidate.number).includes(q) ||
            candidate.identifier.toLowerCase().includes(q) ||
            candidate.title.toLowerCase().includes(q)
          );
        })
        .slice(0, 6)
    : [];
  const activeIndex = matches.length === 0 ? 0 : Math.min(selectedIndex, matches.length - 1);

  function insertMention(target: Issue) {
    if (mention === null) return;
    onChange(`${value.slice(0, mention.start)}#${target.number} `);
    setDismissedAt(null);
    setSelectedIndex(0);
  }

  return (
    <Stack
      onKeyDown={(event) => {
        if (matches.length === 0) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % matches.length);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + matches.length) % matches.length);
        } else if (event.key === "Enter" || event.key === "Tab") {
          const chosen = matches[activeIndex];
          if (chosen !== undefined) {
            event.preventDefault();
            insertMention(chosen);
          }
        } else if (event.key === "Escape" && mention !== null) {
          event.preventDefault();
          setDismissedAt(mention.start);
        }
      }}
    >
      <TextAreaField
        label={label}
        id={id}
        htmlName={htmlName}
        value={value}
        onChange={(next) => {
          onChange(next);
          setDismissedAt(null);
          setSelectedIndex(0);
        }}
        rows={rows}
        width="100%"
        {...(required === true ? { required: true } : {})}
        {...(placeholder !== undefined
          ? { placeholder }
          : issues.length > 0
            ? { placeholder: "Type # to reference an issue" }
            : {})}
      />
      {matches.length > 0 && (
        <Stack as="ul" role="listbox" aria-label="Reference an issue">
          {matches.map((candidate, index) => (
            <Stack
              as="li"
              key={candidate.id}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(candidate);
              }}
            >
              <Text as="span">{candidate.identifier}</Text>
              <Text as="span">{candidate.title}</Text>
              <Text as="span">{issueStatusLabels[candidate.status]}</Text>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
