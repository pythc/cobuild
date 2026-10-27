import { useState } from "react";
import { Button, Popover, Select, Stack, Group } from "@mantine/core";
import { IconTypography, IconChevronDown } from "@tabler/icons-react";
import { Editor, useEditorState } from "@tiptap/react";
import { useTranslation } from "react-i18next";

export function TextFormattingControls({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      size: editor.getAttributes("textStyle").fontSize ?? "default",
      font: editor.getAttributes("textStyle").fontFamily ?? "default",
      height: editor.state.selection.$from.parent.attrs.lineHeight ?? "default",
      text: ["paragraph", "heading"].includes(
        editor.state.selection.$from.parent.type.name,
      ),
    }),
  });
  const props = {
    size: "xs" as const,
    allowDeselect: false,
    comboboxProps: { withinPortal: false },
    disabled: !state.text,
  };
  return (
    <Stack gap="sm" onMouseDown={(e) => e.stopPropagation()}>
      <Select
        {...props}
        label={t("Font family")}
        aria-label={t("Font family")}
        value={state.font}
        data={[
          { value: "default", label: t("Default") },
          { value: "sans-serif", label: t("Sans serif") },
          { value: "serif", label: t("Serif") },
          { value: "monospace", label: t("Monospace") },
        ]}
        onChange={(value) =>
          editor
            .chain()
            .focus()
            .setTextFont(value === "default" ? null : value)
            .run()
        }
      />
      <Group grow align="start" gap="sm">
        <Select
          {...props}
          label={t("Font size")}
          aria-label={t("Font size")}
          value={state.size}
          data={[
            { value: "default", label: t("Default") },
            ...[10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 60, 72].map(
              (size) => ({ value: `${size}px`, label: `${size} px` }),
            ),
          ]}
          onChange={(value) =>
            editor
              .chain()
              .focus()
              .setTextSize(value === "default" ? null : value)
              .run()
          }
        />
        <Select
          {...props}
          label={t("Line height")}
          aria-label={t("Line height")}
          value={state.height}
          data={[
            { value: "default", label: t("Default") },
            ...[1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((height) => ({
              value: String(height),
              label: `${height} ×`,
            })),
          ]}
          onChange={(value) =>
            editor
              .chain()
              .focus()
              .setParagraphLineHeight(value === "default" ? null : value)
              .run()
          }
        />
      </Group>
    </Stack>
  );
}

export function TextFormattingButton({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={260}
      shadow="md"
      zIndex={250}
    >
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          leftSection={<IconTypography size={16} />}
          rightSection={<IconChevronDown size={12} />}
          aria-expanded={opened}
          onClick={() => setOpened((value) => !value)}
        >
          {t("Text formatting")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <TextFormattingControls editor={editor} />
      </Popover.Dropdown>
    </Popover>
  );
}
