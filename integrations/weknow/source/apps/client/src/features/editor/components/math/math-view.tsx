import "katex/dist/katex.min.css";
import katex from "katex";
import { useEffect, useId, useRef, useState } from "react";
import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  ActionIcon,
  Button,
  Group,
  Popover,
  Stack,
  Textarea,
} from "@mantine/core";
import { TextSelection } from "@tiptap/pm/state";
import { IconTrashX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import classes from "./math.module.css";

export function MathView({
  inline = false,
  ...props
}: NodeViewProps & { inline?: boolean }) {
  const { t } = useTranslation();
  const { node, editor, getPos, updateAttributes, selected } = props;
  const container = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState(false);
  const id = useId();
  const text = node.attrs.text ?? "";
  const opened = selected && editor.isEditable;
  useEffect(() => {
    if (!container.current) return;
    try {
      katex.render(text, container.current, {
        displayMode: !inline,
        strict: false,
      });
      setError(false);
    } catch {
      container.current.replaceChildren();
      setError(true);
    }
  }, [text, inline]);

  const finish = () => {
    const pos = getPos();
    if (typeof pos !== "number" || editor.isDestroyed) return;
    const after = pos + node.nodeSize;
    if (inline) editor.commands.setTextSelection(after);
    else {
      const tr = editor.state.tr;
      const next = tr.doc.nodeAt(after);
      // Provide a place to keep writing even at the end of the document or
      // before another atomic block.
      if (!next?.isTextblock)
        tr.insert(after, editor.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
      editor.view.dispatch(tr.scrollIntoView());
    }
    editor.commands.focus();
  };

  return (
    <Popover
      opened={opened}
      trapFocus
      position="top"
      shadow="md"
      width={inline ? 400 : 500}
      withArrow
      zIndex={201}
      id={id}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>
        <NodeViewWrapper
          as={inline ? "span" : "div"}
          contentEditable={false}
          data-type={inline ? "mathInline" : "mathBlock"}
          data-katex="true"
          className={[
            inline ? classes.mathInline : classes.mathBlock,
            selected ? classes.selected : "",
            error ? classes.error : "",
            !text.trim() ? classes.empty : "",
          ].join(" ")}
          onClick={() => {
            const pos = getPos();
            if (editor.isEditable && typeof pos === "number")
              editor.commands.setNodeSelection(pos);
          }}
        >
          <span ref={container} />
          {!text.trim() && <span>{t("Empty equation")}</span>}
          {error && <span>{t("Invalid equation")}</span>}
        </NodeViewWrapper>
      </Popover.Target>
      <Popover.Dropdown style={{ maxWidth: "calc(100vw - 24px)" }}>
        <Stack gap="sm">
          <Textarea
            aria-label="LaTeX"
            data-autofocus
            minRows={inline ? 1 : 3}
            maxRows={8}
            autosize
            draggable={false}
            value={text}
            placeholder="E = mc^2"
            onChange={(event) =>
              updateAttributes({ text: event.currentTarget.value })
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (
                event.key === "Escape" ||
                (event.key === "Enter" && !event.shiftKey)
              ) {
                event.preventDefault();
                event.stopPropagation();
                finish();
              }
            }}
          />
          <Group justify="space-between">
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t("Delete equation")}
              onClick={() => props.deleteNode()}
            >
              <IconTrashX size={18} />
            </ActionIcon>
            <Button size="xs" onClick={finish}>
              {t("Done")}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
