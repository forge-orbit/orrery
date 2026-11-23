import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { Issue, MentionActor, MentionAgent, MentionHuman } from "@orrery/contract";
import { useQuery } from "@tanstack/react-query";
import {
  AtSign,
  Bold,
  Code,
  Hash,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  SquareCode,
  Strikethrough,
  Table2,
} from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { uploadAttachment } from "../attachments/index.ts";
import { ApiProblemError } from "../../lib/api.ts";
import { TextAreaField } from "../../lib/fields.tsx";
import {
  attachmentMarkdown,
  attachmentPlaceholder,
  continueListOnEnter,
  insertAtTrigger,
  insertCode,
  insertCodeBlock,
  insertLink,
  insertMentionTrigger,
  insertTable,
  pasteUrlOverSelection,
  prefixLines,
  replaceAttachmentPlaceholder,
  wrapSelection,
  type TextSelectionEdit,
} from "../../lib/markdown-toolbar.ts";
import { AgentAvatar } from "../../lib/harness.tsx";
import { HumanAvatar } from "../../lib/avatar.tsx";
import { Markdown } from "../../lib/Markdown.tsx";
import {
  actorLabel,
  filterMentionCandidates,
  findAtMention,
  mentionToken,
} from "../../lib/mentions.ts";
import { issueStatusLabels } from "./issue-status.ts";
import { mentionCandidatesQuery } from "./queries.ts";

function findHashMention(text: string): { start: number; query: string } | null {
  const match = /(?:^|[\s(])#([a-zA-Z0-9-]*)$/.exec(text);
  if (match === null) return null;
  const query = match[1] ?? "";
  const hashIndex = text.lastIndexOf("#");
  if (hashIndex < 0) return null;
  return { start: hashIndex, query };
}

type Suggestion =
  | { kind: "issue"; key: string; token: string; label: string; issue: Issue }
  | { kind: "human"; key: string; token: string; label: string; actor: MentionHuman }
  | { kind: "agent"; key: string; token: string; label: string; actor: MentionAgent };

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  if (suggestion.kind === "issue") {
    return (
      <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
        <Text as="span" type="code" color="secondary">
          {suggestion.issue.identifier}
        </Text>
        <Text as="span" type="body" weight="medium" color="primary">
          {suggestion.label}
        </Text>
      </Stack>
    );
  }
  return (
    <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
      {suggestion.actor.type === "human" ? (
        <HumanAvatar
          name={actorLabel(suggestion.actor)}
          avatarUrl={suggestion.actor.avatarUrl}
          size="xsm"
          tooltip={false}
        />
      ) : (
        <AgentAvatar name={suggestion.actor.name} size={16} />
      )}
      <Text as="span" type="code" color="secondary">
        {suggestion.token}
      </Text>
      <Text as="span" type="body" weight="medium" color="primary">
        {suggestion.label}
      </Text>
      {suggestion.kind === "agent" && (
        <Token label="Agent" color="orange" size="sm" data-mention-agent="" />
      )}
    </Stack>
  );
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
  /** Project that receives pasted, dropped, or picked files. Omit for detached composers. */
  projectId?: string;
  /** Focused by a parent action such as "Quote reply". */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Increment to bring the editor back to write mode before focusing it. */
  focusSignal?: number;
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
  projectId,
  inputRef,
  focusSignal = 0,
}: IssueMentionTextAreaProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  const uploadSequence = useRef(0);
  // Mirror the controlled value so an in-flight upload never overwrites an
  // external reset (Create more, Quote reply, or a parent-driven edit).
  // eslint-disable-next-line react/refs -- intentional: synchronous mirror of a controlled prop.
  valueRef.current = value;
  const [lastFocusSignal, setLastFocusSignal] = useState(focusSignal);
  if (focusSignal !== lastFocusSignal) {
    setLastFocusSignal(focusSignal);
    if (mode === "preview") setMode("write");
  }
  const activeRef = inputRef ?? textareaRef;

  const candidates = useQuery({
    ...mentionCandidatesQuery(projectId ?? ""),
    enabled: projectId !== undefined,
  });
  const mentionHumans: readonly MentionHuman[] = candidates.data?.humans ?? [];
  const mentionAgents: readonly MentionAgent[] = candidates.data?.agents ?? [];
  const mentionActors: readonly MentionActor[] = [...mentionHumans, ...mentionAgents];

  const atMention = mode === "write" && mentionActors.length > 0 ? findAtMention(value) : null;
  const hashMention = mode === "write" && issues.length > 0 ? findHashMention(value) : null;
  const mention = atMention ?? hashMention;
  const showMenu = mention !== null && dismissedAt !== mention.start;
  const suggestions: Suggestion[] = !showMenu
    ? []
    : atMention !== null
      ? filterMentionCandidates(mentionHumans, mentionAgents, atMention.query).map(
          (actor): Suggestion =>
            actor.type === "human"
              ? {
                  kind: "human",
                  key: `human-${actor.id}`,
                  token: mentionToken(actor),
                  label: actorLabel(actor),
                  actor,
                }
              : {
                  kind: "agent",
                  key: `agent-${actor.id}`,
                  token: mentionToken(actor),
                  label: actorLabel(actor),
                  actor,
                },
        )
      : issues
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
          .map((issue) => ({
            kind: "issue" as const,
            key: issue.id,
            token: `#${issue.number}`,
            label: issue.title,
            issue,
          }));
  const activeIndex =
    suggestions.length === 0 ? 0 : Math.min(selectedIndex, suggestions.length - 1);

  function commitEdit(edit: TextSelectionEdit) {
    setDraft(edit.value);
    setDismissedAt(null);
    setSelectedIndex(0);
    requestAnimationFrame(() => {
      const target = activeRef.current;
      if (target === null) return;
      target.focus();
      target.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }

  function applyEdit(compute: (start: number, end: number) => TextSelectionEdit) {
    const el = activeRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    commitEdit(compute(start, end));
  }

  function insertSuggestion(suggestion: Suggestion) {
    if (mention === null) return;
    setDraft(`${value.slice(0, mention.start)}${suggestion.token} `);
    setDismissedAt(null);
    setSelectedIndex(0);
  }

  function setDraft(next: string) {
    valueRef.current = next;
    onChange(next);
  }

  async function uploadFiles(files: FileList | File[] | null) {
    if (projectId === undefined || files === null) return;
    const el = activeRef.current;
    for (const file of Array.from(files)) {
      const uploadPlaceholder = attachmentPlaceholder(file.name, String(++uploadSequence.current));
      const start = el?.selectionStart ?? valueRef.current.length;
      const end = el?.selectionEnd ?? valueRef.current.length;
      setDraft(
        `${valueRef.current.slice(0, start)}${uploadPlaceholder}\n${valueRef.current.slice(end)}`,
      );
      setUploading((count) => count + 1);
      setUploadError(null);
      try {
        const uploaded = await uploadAttachment(projectId, file);
        const edit = replaceAttachmentPlaceholder(
          valueRef.current,
          uploadPlaceholder,
          attachmentMarkdown(file.name, uploaded.downloadUrl, uploaded.inline),
        );
        setDraft(edit.value);
      } catch (error) {
        const edit = replaceAttachmentPlaceholder(valueRef.current, uploadPlaceholder, "");
        setDraft(edit.value);
        setUploadError(
          error instanceof ApiProblemError
            ? error.problem.title
            : error instanceof Error
              ? error.message
              : "The file could not be attached.",
        );
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }

  return (
    <Stack
      width="100%"
      gap={1.5}
      data-attachment-dropzone={projectId === undefined ? "off" : "on"}
      onDragOver={(event) => {
        if (projectId !== undefined) event.preventDefault();
      }}
      onDrop={(event) => {
        if (projectId === undefined) return;
        event.preventDefault();
        void uploadFiles(event.dataTransfer.files);
      }}
      onKeyDown={(event) => {
        if (mode !== "write") return;

        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
          const key = event.key.toLowerCase();
          if (key === "b") {
            event.preventDefault();
            applyEdit((s, e) => wrapSelection(value, s, e, "**", "**", "bold text"));
            return;
          }
          if (key === "i") {
            event.preventDefault();
            applyEdit((s, e) => wrapSelection(value, s, e, "*", "*", "italic text"));
            return;
          }
          if (event.shiftKey && key === "x") {
            event.preventDefault();
            applyEdit((s, e) => wrapSelection(value, s, e, "~~", "~~", "strikethrough"));
            return;
          }
          if (key === "e") {
            event.preventDefault();
            applyEdit((s, e) => insertCode(value, s, e));
            return;
          }
          if (key === "k") {
            event.preventDefault();
            applyEdit((s, e) => insertLink(value, s, e));
            return;
          }
        }

        if (suggestions.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % suggestions.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const chosen = suggestions[activeIndex];
            if (chosen !== undefined) {
              event.preventDefault();
              insertSuggestion(chosen);
              return;
            }
          }
          if (event.key === "Escape" && mention !== null) {
            event.preventDefault();
            setDismissedAt(mention.start);
            return;
          }
        }

        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          const el = activeRef.current;
          if (el !== null && document.activeElement === el) {
            const edit = continueListOnEnter(value, el.selectionStart, el.selectionEnd);
            if (edit !== null) {
              event.preventDefault();
              commitEdit(edit);
            }
          }
        }
      }}
    >
      <Stack direction="horizontal" justify="between" vAlign="center" gap={2} wrap="wrap">
        <Text as="span" type="label" weight="medium" color="primary" aria-hidden="true">
          {label}
          {required === true ? " *" : ""}
        </Text>
        <Text as="span" type="supporting" color="secondary">
          Markdown supported
        </Text>
      </Stack>

      <Card padding={0}>
        <Stack
          direction="horizontal"
          justify="between"
          vAlign="center"
          gap={2}
          wrap="wrap"
          padding={2}
        >
          <TabList
            value={mode}
            onChange={(next) => setMode(next === "preview" ? "preview" : "write")}
            role="tablist"
            aria-label="Editor mode"
            size="sm"
          >
            <Tab value="write" label="Write" panelId={`${id}-write-panel`} />
            <Tab value="preview" label="Preview" panelId={`${id}-preview-panel`} />
          </TabList>

          {mode === "write" && (
            <Stack
              direction="horizontal"
              gap={0.5}
              vAlign="center"
              wrap="wrap"
              role="toolbar"
              aria-label="Formatting"
            >
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Heading"
                tooltip="Add heading"
                icon={<Icon icon={Heading2} />}
                onClick={() => applyEdit((s, e) => prefixLines(value, s, e, "## "))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Bold"
                tooltip="Bold (Ctrl+B)"
                icon={<Icon icon={Bold} />}
                onClick={() =>
                  applyEdit((s, e) => wrapSelection(value, s, e, "**", "**", "bold text"))
                }
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Italic"
                tooltip="Italic (Ctrl+I)"
                icon={<Icon icon={Italic} />}
                onClick={() =>
                  applyEdit((s, e) => wrapSelection(value, s, e, "*", "*", "italic text"))
                }
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Strikethrough"
                tooltip="Strikethrough (Ctrl+Shift+X)"
                icon={<Icon icon={Strikethrough} />}
                onClick={() =>
                  applyEdit((s, e) => wrapSelection(value, s, e, "~~", "~~", "strikethrough"))
                }
              />

              <Divider orientation="vertical" />

              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Quote"
                tooltip="Insert a quote"
                icon={<Icon icon={Quote} />}
                onClick={() => applyEdit((s, e) => prefixLines(value, s, e, "> "))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Inline code"
                tooltip="Inline code (Ctrl+E)"
                icon={<Icon icon={Code} />}
                onClick={() => applyEdit((s, e) => insertCode(value, s, e))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Code block"
                tooltip="Insert code block"
                icon={<Icon icon={SquareCode} />}
                onClick={() => applyEdit((s, e) => insertCodeBlock(value, s, e))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Link"
                tooltip="Add a link (Ctrl+K)"
                icon={<Icon icon={Link2} />}
                onClick={() => applyEdit((s, e) => insertLink(value, s, e))}
              />

              <Divider orientation="vertical" />

              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Bulleted list"
                tooltip="Add a bulleted list"
                icon={<Icon icon={List} />}
                onClick={() => applyEdit((s, e) => prefixLines(value, s, e, "- "))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Numbered list"
                tooltip="Add a numbered list"
                icon={<Icon icon={ListOrdered} />}
                onClick={() => applyEdit((s, e) => prefixLines(value, s, e, (i) => `${i + 1}. `))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Task list"
                tooltip="Add a task list"
                icon={<Icon icon={ListChecks} />}
                onClick={() => applyEdit((s, e) => prefixLines(value, s, e, "- [ ] "))}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                label="Table"
                tooltip="Insert a table"
                icon={<Icon icon={Table2} />}
                onClick={() => applyEdit((s, e) => insertTable(value, s, e))}
              />

              {issues.length > 0 && (
                <>
                  <Divider orientation="vertical" />
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    label="Reference issue"
                    tooltip="Reference an issue (#)"
                    icon={<Icon icon={Hash} />}
                    onClick={() => applyEdit((s, e) => insertMentionTrigger(value, s, e))}
                  />
                </>
              )}
              {mentionActors.length > 0 && (
                <>
                  {issues.length === 0 && <Divider orientation="vertical" />}
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    label="Mention a teammate"
                    tooltip="Mention a teammate (@)"
                    icon={<Icon icon={AtSign} />}
                    onClick={() => applyEdit((s, e) => insertAtTrigger(value, s, e))}
                  />
                </>
              )}
            </Stack>
          )}
        </Stack>

        <Divider />

        <Stack padding={2}>
          {mode === "write" ? (
            <Stack id={`${id}-write-panel`} role="tabpanel" width="100%">
              <TextAreaField
                ref={activeRef}
                label={label}
                isLabelHidden
                id={id}
                htmlName={htmlName}
                value={value}
                onChange={(next) => {
                  setDraft(next);
                  setDismissedAt(null);
                  setSelectedIndex(0);
                }}
                onPaste={(event) => {
                  if (projectId !== undefined && event.clipboardData.files.length > 0) {
                    event.preventDefault();
                    void uploadFiles(event.clipboardData.files);
                    return;
                  }
                  const el = activeRef.current;
                  if (el === null) return;
                  const pasted = event.clipboardData.getData("text");
                  const edit = pasteUrlOverSelection(
                    value,
                    el.selectionStart,
                    el.selectionEnd,
                    pasted,
                  );
                  if (edit !== null) {
                    event.preventDefault();
                    commitEdit(edit);
                  }
                }}
                rows={rows}
                width="100%"
                {...(required === true ? { required: true } : {})}
                {...(placeholder !== undefined
                  ? { placeholder }
                  : issues.length > 0
                    ? { placeholder: "Write in Markdown… Type # for an issue or @ to mention" }
                    : { placeholder: "Write in Markdown…" })}
              />
            </Stack>
          ) : (
            <Stack id={`${id}-preview-panel`} role="tabpanel" padding={2} width="100%">
              {value.trim() === "" ? (
                <Text type="supporting" color="secondary">
                  Nothing to preview.
                </Text>
              ) : (
                <Markdown
                  mentionActors={mentionActors}
                  {...(issues.length > 0 ? { issueRefs: issues } : {})}
                >
                  {value}
                </Markdown>
              )}
            </Stack>
          )}
        </Stack>

        {mode === "write" && projectId !== undefined && (
          <Stack padding={2} data-attach-bar="">
            <FileInput
              label="Add files"
              isLabelHidden
              value={null}
              isMultiple
              mode="input"
              accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.log,.md,.json,.csv,.patch,.diff,.docx,.xlsx,.pptx,.zip,.gz,.svg"
              placeholder="Paste, drop, or click to add files"
              isLoading={uploading > 0}
              onChange={(files) =>
                void uploadFiles(files === null ? null : Array.isArray(files) ? files : [files])
              }
              {...(uploadError === null
                ? {}
                : { status: { type: "error" as const, message: uploadError } })}
            />
          </Stack>
        )}
      </Card>

      {suggestions.length > 0 && (
        <Card elevation="med" padding={1}>
          <Stack
            as="ul"
            role="listbox"
            aria-label={atMention !== null ? "Mention a teammate" : "Reference an issue"}
            gap={0.5}
          >
            {suggestions.map((suggestion, index) => (
              <Stack
                as="li"
                key={suggestion.key}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertSuggestion(suggestion);
                }}
              >
                <Card variant={index === activeIndex ? "muted" : "transparent"} padding={2}>
                  <Stack direction="horizontal" justify="between" vAlign="center" gap={2}>
                    <SuggestionRow suggestion={suggestion} />
                    {suggestion.kind === "issue" && (
                      <Token
                        label={issueStatusLabels[suggestion.issue.status]}
                        color="gray"
                        size="sm"
                      />
                    )}
                  </Stack>
                </Card>
              </Stack>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
