import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import type { ProjectLabel } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { createProjectLabel, deleteProjectLabel, updateProjectLabel } from "./commands.ts";
import { LabelPill, tokenColorForHex } from "./LabelPill.tsx";
import { issuesQuery, projectActivityQuery, projectLabelsQuery } from "./queries.ts";

const PRESET_COLORS = [
  { name: "Crimson", hex: "#d94848" },
  { name: "Rose", hex: "#d6457d" },
  { name: "Tangerine", hex: "#e06c2b" },
  { name: "Amber", hex: "#c88a1e" },
  { name: "Emerald", hex: "#2f9e66" },
  { name: "Teal", hex: "#1f8a8a" },
  { name: "Sky", hex: "#2884c8" },
  { name: "Cobalt", hex: "#3b74d6" },
  { name: "Violet", hex: "#7c52d9" },
  { name: "Slate", hex: "#64748b" },
] as const;

const VALID_HEX = /^#[0-9a-fA-F]{6}$/;

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

function nextPresetColor(current: string): string {
  const index = PRESET_COLORS.findIndex((p) => p.hex.toLowerCase() === current.toLowerCase());
  const next = PRESET_COLORS[(index + 1) % PRESET_COLORS.length];
  return next?.hex ?? "#3b74d6";
}

function ColorSwatches({
  value,
  onSelect,
  groupLabel,
}: {
  value: string;
  onSelect: (hex: string) => void;
  groupLabel: string;
}) {
  return (
    <Stack direction="horizontal" gap={1.5} align="center">
      <Text type="supporting" color="secondary">
        Presets
      </Text>
      <Stack direction="horizontal" gap={1} role="group" aria-label={groupLabel}>
        {PRESET_COLORS.map((preset) => {
          const active = value.toLowerCase() === preset.hex.toLowerCase();
          return (
            <Button
              key={preset.hex}
              type="button"
              variant={active ? "primary" : "secondary"}
              size="sm"
              label={preset.name}
              icon={active ? <Icon icon="check" /> : undefined}
              aria-label={`${preset.name} (${preset.hex})`}
              aria-pressed={active}
              onClick={() => onSelect(preset.hex)}
            />
          );
        })}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        label="Next color"
        icon={<Icon icon="arrowsUpDown" />}
        onClick={() => onSelect(nextPresetColor(value))}
      />
    </Stack>
  );
}

function ColorInputField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <Stack>
      <TextField
        label={label}
        id={id}
        htmlName="color"
        value={value}
        onChange={onChange}
        placeholder="#3b74d6"
        width="100%"
        required
      />
    </Stack>
  );
}

function LabelPreview({ name, color }: { name: string; color: string }) {
  const validHex = VALID_HEX.test(color) ? color : "#64748b";
  return (
    <Stack direction="horizontal" gap={1.5} align="center">
      <Text type="supporting" color="secondary">
        Preview
      </Text>
      <Token
        label={name.trim() === "" ? "Label name" : name.trim()}
        color={tokenColorForHex(validHex)}
        size="sm"
        data-label-preview=""
      />
    </Stack>
  );
}

export function ProjectLabels({
  projectId,
  labels,
  canContribute,
}: {
  projectId: string;
  labels: ProjectLabel[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b74d6");
  const [editingId, setEditingId] = useState<string>();
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<ProjectLabel>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectLabelsQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: ["issues"] }),
      queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
    ]);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await createProjectLabel(projectId, { name, color });
      setName("");
      setColor(nextPresetColor(color));
      await refresh();
      toast({ body: "Label created." });
    } catch (cause) {
      setError(messageOf(cause, "Could not create the label."));
    } finally {
      setSaving(false);
    }
  }

  async function onUpdate(event: FormEvent<HTMLFormElement>, label: ProjectLabel) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await updateProjectLabel(label.id, { name: editName, color: editColor });
      setEditingId(undefined);
      await refresh();
      toast({ body: "Label updated." });
    } catch (cause) {
      const msg = messageOf(cause, "Could not save the label.");
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(label: ProjectLabel) {
    setSaving(true);
    setError(undefined);
    try {
      await deleteProjectLabel(label.id);
      setConfirmDelete(undefined);
      if (editingId === label.id) setEditingId(undefined);
      await refresh();
      toast({ body: `Deleted label "${label.name}".` });
    } catch (cause) {
      const msg = messageOf(cause, "Could not delete the label.");
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap={3}>
      {canContribute && (
        <Section padding={3}>
          <form onSubmit={(event) => void onCreate(event)}>
            <Stack>
              <Stack>
                <Heading level={2} color="inherit">
                  Create label
                </Heading>
                <Text type="supporting" color="secondary">
                  Categorize issues across the board and issue lists.
                </Text>
              </Stack>
              <LabelPreview name={name} color={color} />
            </Stack>

            <Stack>
              <TextField
                label="New label name"
                id="new-label-name"
                htmlName="name"
                value={name}
                onChange={setName}
                maxLength={50}
                placeholder="e.g. Bug, Backend, UI"
                width="100%"
                required
              />
              <ColorInputField
                id="new-label-color"
                label="New label color"
                value={color}
                onChange={setColor}
              />
              <Stack>
                <Button
                  type="submit"
                  label="Create label"
                  variant="primary"
                  isDisabled={saving}
                  isLoading={saving}
                />
              </Stack>
            </Stack>

            <ColorSwatches value={color} onSelect={setColor} groupLabel="Color swatches" />
          </form>
        </Section>
      )}

      <Section padding={3}>
        <Stack gap={3}>
          <Stack>
            <Heading level={2} color="inherit">
              Labels
            </Heading>
            <Text type="supporting" color="secondary">
              {labels.length === 1 ? "1 label" : `${labels.length} labels`}
            </Text>
          </Stack>
          {error !== undefined && (
            <Banner status="error" role="alert" title="Label update failed" description={error} />
          )}
          {labels.length === 0 ? (
            <EmptyState
              title="No labels yet"
              description="Create labels to categorize issues on the board and in issue lists."
              isCompact
              headingLevel={3}
            />
          ) : (
            <Table aria-label="Project labels">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Label</TableHeaderCell>
                  <TableHeaderCell>Color</TableHeaderCell>
                  {canContribute && <TableHeaderCell>Actions</TableHeaderCell>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {labels.map((label) => (
                  <TableRow key={label.id} data-project-label-id={label.id}>
                    {editingId === label.id ? (
                      <TableCell colSpan={canContribute ? 3 : 2}>
                        <form onSubmit={(event) => void onUpdate(event, label)}>
                          <Stack>
                            <LabelPreview name={editName} color={editColor} />
                          </Stack>
                          <Stack>
                            <TextField
                              label="Label name"
                              id={`label-name-${label.id}`}
                              htmlName="name"
                              value={editName}
                              onChange={setEditName}
                              maxLength={50}
                              width="100%"
                              required
                            />
                            <ColorInputField
                              id={`label-color-${label.id}`}
                              label="Label color"
                              value={editColor}
                              onChange={setEditColor}
                            />
                            <Stack direction="horizontal" gap={1}>
                              <Button
                                type="submit"
                                label="Save label"
                                variant="primary"
                                size="sm"
                                isDisabled={saving}
                                isLoading={saving}
                              />
                              <Button
                                type="button"
                                label="Cancel"
                                variant="ghost"
                                size="sm"
                                isDisabled={saving}
                                onClick={() => setEditingId(undefined)}
                              />
                            </Stack>
                          </Stack>
                          <ColorSwatches
                            value={editColor}
                            onSelect={setEditColor}
                            groupLabel="Edit color swatches"
                          />
                        </form>
                      </TableCell>
                    ) : (
                      <>
                        <TableCell>
                          <LabelPill label={label} />
                        </TableCell>
                        <TableCell>
                          <code>{label.color}</code>
                        </TableCell>
                        {canContribute && (
                          <TableCell>
                            <Stack direction="horizontal" gap={1}>
                              <Button
                                type="button"
                                label="Edit label"
                                variant="secondary"
                                size="sm"
                                isDisabled={saving}
                                onClick={() => {
                                  setEditingId(label.id);
                                  setEditName(label.name);
                                  setEditColor(label.color);
                                  setError(undefined);
                                }}
                              />
                              <Button
                                type="button"
                                label="Delete label"
                                variant="destructive"
                                size="sm"
                                isDisabled={saving}
                                onClick={() => setConfirmDelete(label)}
                              />
                            </Stack>
                          </TableCell>
                        )}
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Section>

      <AlertDialog
        isOpen={confirmDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(undefined);
        }}
        title="Delete label?"
        description={
          confirmDelete === undefined
            ? "Delete this label?"
            : `Delete "${confirmDelete.name}"? It will be removed from all issues in this project.`
        }
        actionLabel="Delete label"
        actionVariant="destructive"
        isActionLoading={saving}
        onAction={() => {
          if (confirmDelete !== undefined) void onDelete(confirmDelete);
        }}
      />
    </Stack>
  );
}
