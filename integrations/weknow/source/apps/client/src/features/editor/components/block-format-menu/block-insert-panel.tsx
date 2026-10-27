import { useMemo } from "react";
import { UnstyledButton, Text, Group } from "@mantine/core";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { useHasFeature, Feature } from "@/platform/core-only";
import { blockInsertItems, insertBelowBlock } from "./block-insert-commands";
import classes from "./block-format-menu.module.css";

export function BlockInsertPanel({
  editor,
  onClose,
}: {
  editor: Editor;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const hasBases = useHasFeature(Feature.BASES);
  const groups = useMemo(
    () => blockInsertItems(editor, "", hasBases),
    [editor, hasBases],
  );
  // These conversions are already available in the icon toolbar. Keep the
  // insertion list concise without duplicating the same actions.
  const quickFormats = new Set([
    "Text",
    "To-do list",
    "Heading 1",
    "Heading 2",
    "Heading 3",
    "Bullet list",
    "Numbered list",
    "Quote",
    "Code",
    "Callout",
    "Toggle block",
  ]);
  const items = Object.values(groups)
    .flat()
    .filter((item) => !quickFormats.has(item.title));
  const categories = [
    [
      "Common",
      new Set([
        "Text",
        "To-do list",
        "Heading 1",
        "Heading 2",
        "Heading 3",
        "Bullet list",
        "Numbered list",
        "Quote",
        "Code",
        "Divider",
        "Callout",
        "Toggle block",
      ]),
    ],
    [
      "Media and files",
      new Set(["Image", "Video", "Audio", "Embed PDF", "File attachment"]),
    ],
    [
      "Layout and collaboration",
      new Set([
        "Table",
        "Base (Inline)",
        "Kanban",
        "2 Columns",
        "3 Columns",
        "4 Columns",
        "5 Columns",
        "Synced block",
        "Subpages (Child pages)",
      ]),
    ],
    [
      "Diagrams and formulas",
      new Set([
        "Math inline",
        "Math block",
        "Mermaid diagram",
        "Draw.io (diagrams.net)",
        "Excalidraw (Whiteboard)",
      ]),
    ],
    ["Embeds and more", null],
  ] as const;
  const assigned = new Set<string>();
  const sections = categories
    .map(([name, titles]) => {
      const commands = items.filter((item) =>
        titles ? titles.has(item.title) : !assigned.has(item.title),
      );
      commands.forEach((item) => assigned.add(item.title));
      return { name, commands };
    })
    .filter((section) => section.commands.length);
  return (
    <div className={classes.insertPanel}>
      <div className={classes.insertList}>
        {sections.map(({ name, commands }) => (
          <div key={name}>
            <Text size="xs" c="dimmed" px={7} pt={10} pb={4}>
              {t(name)}
            </Text>
            {commands.map((item) => {
              const Icon = item.icon;
              return (
                <UnstyledButton
                  key={item.title}
                  className={classes.row}
                  disabled={item.disable?.(editor)}
                  onClick={() => {
                    onClose();
                    insertBelowBlock(editor, item);
                  }}
                >
                  <Group gap={9} wrap="nowrap">
                    <Icon size={18} />
                    <Text size="sm">{t(item.title)}</Text>
                  </Group>
                </UnstyledButton>
              );
            })}
          </div>
        ))}
        {!items.length && (
          <Text c="dimmed" size="sm" p="sm">
            {t("No results")}
          </Text>
        )}
      </div>
    </div>
  );
}
