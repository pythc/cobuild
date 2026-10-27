import { useEffect, useLayoutEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { blockFormatMenuEditorAtom } from "../../atoms/block-format-menu-atom";
import { Editor, useEditorState } from "@tiptap/react";
import {
  Popover,
  FocusTrap,
  Portal,
  Divider,
  ActionIcon,
  Tooltip,
  Group,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconX,
  IconTypography,
  IconInfoCircle,
  IconCaretRightFilled,
  IconH1,
  IconH2,
  IconH3,
  IconBlockquote,
  IconList,
  IconListNumbers,
  IconCheckbox,
  IconCode,
  IconLetterT,
  IconChevronRight,
  IconChevronLeft,
  IconAlignLeft,
  IconAlignCenter,
  IconAlignRight,
  IconAlignJustified,
  IconIndentIncrease,
  IconIndentDecrease,
} from "@tabler/icons-react";
import { blockMenuPlacement, BLOCK_MENU_WIDTH } from "./block-menu-placement";
import {
  blockSidebarPlacement,
  reserveBlockSidebar,
  type BlockSidebarPlacement,
} from "./block-menu-sidebar";
import classes from "./block-format-menu.module.css";
import { useTranslation } from "react-i18next";
import { TextFormattingControls } from "../text-formatting/text-formatting";
import {
  BLOCK_FORMAT_EVENT,
  BlockFormatDetail,
} from "../../extensions/block-format-target";
import { toggleParagraphQuote } from "../../extensions/paragraph-commands";

import { BlockInsertPanel } from "./block-insert-panel";

export function BlockFormatMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [sidebar, setSidebar] = useState<BlockSidebarPlacement | null>(null);
  const [anchor, setAnchor] = useState<BlockFormatDetail | null>(null);
  const [panel, setPanel] = useState<"main" | "typography" | "alignment">(
    "main",
  );
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      textBlock: editor.state.selection.$from.parent.isTextblock,
      heading: editor.isActive("heading")
        ? editor.getAttributes("heading").level
        : 0,
      quote: editor.isActive("blockquote"),
      bullet: editor.isActive("bulletList"),
      ordered: editor.isActive("orderedList"),
      task: editor.isActive("taskList"),
      code: editor.isActive("codeBlock"),
      callout: editor.isActive("callout"),
      details: editor.isActive("details"),
      align:
        editor.getAttributes("paragraph").textAlign ??
        editor.getAttributes("heading").textAlign ??
        "left",
    }),
  });
  const setMenuEditor = useSetAtom(blockFormatMenuEditorAtom);
  useLayoutEffect(() => {
    const dom = editor.view.dom;
    if (anchor) dom.dataset.blockFormatOpen = "true";
    else delete dom.dataset.blockFormatOpen;
    setMenuEditor((current) =>
      anchor
        ? { editor }
        : current.editor === editor
          ? { editor: null }
          : current,
    );
    return () => {
      delete dom.dataset.blockFormatOpen;
      setMenuEditor((current) =>
        current.editor === editor ? { editor: null } : current,
      );
    };
  }, [editor, anchor, setMenuEditor]);
  const opened = !!anchor;
  useLayoutEffect(() => {
    if (!opened || !sidebar) return;
    return reserveBlockSidebar(editor.view.dom);
  }, [editor, opened, sidebar]);

  useLayoutEffect(() => {
    if (!opened) return;
    const host = editor.view.dom.parentElement;
    const container = host?.parentElement ?? host;
    if (!container) return;
    const initial = container.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const current = container.getBoundingClientRect();
      if (
        Math.abs(current.width - initial.width) > 1 ||
        Math.abs(current.left - initial.left) > 1
      )
        setAnchor(null);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [editor, opened]);

  useEffect(() => {
    const followParagraph = () =>
      setAnchor((current) => {
        if (!current?.block || editor.isDestroyed) return current;
        const { $from } = editor.state.selection;
        if (!$from.depth) return current;
        const node = editor.view.nodeDOM($from.before());
        if (!(node instanceof Element)) return current;
        const rect = node.getBoundingClientRect();
        const previous = current.block;
        if (
          rect.left === previous.left &&
          rect.top === previous.top &&
          rect.right === previous.right &&
          rect.bottom === previous.bottom
        )
          return current;
        return {
          ...current,
          left: current.left + rect.left - previous.left,
          top: current.top + rect.top - previous.top,
          block: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          },
        };
      });
    editor.on("transaction", followParagraph);
    return () => {
      editor.off("transaction", followParagraph);
    };
  }, [editor]);
  useEffect(() => {
    const dom = editor.view.dom;
    const open = (event: Event) => {
      if (editor.isEditable) {
        const detail = (event as CustomEvent<BlockFormatDetail>).detail;
        setPanel("main");
        setSidebar(
          blockMenuPlacement(detail, window.innerHeight).mode === "sidebar"
            ? blockSidebarPlacement(editor.view.dom, window.innerHeight)
            : null,
        );
        setAnchor(detail);
      }
    };
    const close = () => setAnchor(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dom.dataset.blockFormatOpen === "true") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const onScroll = (event: Event) => {
      // Scrolling a select's own dropdown should not close the paragraph menu.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-block-format-menu]")
      )
        return;
      close();
    };
    dom.addEventListener(BLOCK_FORMAT_EVENT, open);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      dom.removeEventListener(BLOCK_FORMAT_EVENT, open);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editor]);

  const convert = (
    type: "paragraph" | "heading" | "blockquote",
    level?: 1 | 2 | 3,
  ) => {
    if (!editor.isEditable) return;
    const chain = editor.chain().focus();
    if (type === "blockquote") toggleParagraphQuote(editor);
    else {
      if (editor.isActive("blockquote")) chain.lift("blockquote");
      if (type === "heading") chain.setHeading({ level: level! }).run();
      else chain.setParagraph().run();
    }
    setAnchor(null);
  };
  const run = (action: () => void) => {
    if (!editor.isEditable) return;
    action();
    setAnchor(null);
  };
  const icons = [
    {
      label: "Text",
      Icon: IconLetterT,
      active:
        !state.heading &&
        !state.quote &&
        !state.bullet &&
        !state.ordered &&
        !state.task &&
        !state.code,
      action: () => convert("paragraph"),
    },
    {
      label: "Heading 1",
      Icon: IconH1,
      active: state.heading === 1,
      action: () => convert("heading", 1),
    },
    {
      label: "Heading 2",
      Icon: IconH2,
      active: state.heading === 2,
      action: () => convert("heading", 2),
    },
    {
      label: "Heading 3",
      Icon: IconH3,
      active: state.heading === 3,
      action: () => convert("heading", 3),
    },
    {
      label: "Numbered List",
      Icon: IconListNumbers,
      active: state.ordered,
      action: () =>
        run(() => {
          editor.chain().focus().toggleOrderedList().run();
        }),
    },
    {
      label: "Bullet List",
      Icon: IconList,
      active: state.bullet,
      action: () =>
        run(() => {
          editor.chain().focus().toggleBulletList().run();
        }),
    },
    {
      label: "To-do List",
      Icon: IconCheckbox,
      active: state.task,
      action: () =>
        run(() => {
          editor.chain().focus().toggleTaskList().run();
        }),
    },
    {
      label: "Code block",
      Icon: IconCode,
      active: state.code,
      action: () =>
        run(() => {
          editor.chain().focus().toggleCodeBlock().run();
        }),
    },
    {
      label: "Quote",
      Icon: IconBlockquote,
      active: state.quote,
      action: () => convert("blockquote"),
    },
  ];
  if (editor.schema.nodes.callout)
    icons.push({
      label: "Callout",
      Icon: IconInfoCircle,
      active: state.callout,
      action: () =>
        run(() => {
          editor.chain().focus().toggleCallout().run();
        }),
    });
  if (editor.schema.nodes.details)
    icons.push({
      label: "Toggle block",
      Icon: IconCaretRightFilled,
      active: state.details,
      action: () =>
        run(() => {
          editor.chain().focus().setDetails().run();
        }),
    });
  const placement = blockMenuPlacement(
    anchor ?? { left: 0, top: 0 },
    window.innerHeight,
  );
  const menuContents =
    panel === "main" ? (
      <>
        <div className={classes.icons}>
          {icons.map(({ label, Icon, active, action }) => (
            <Tooltip
              key={label}
              label={t(label)}
              withinPortal={false}
              openDelay={350}
            >
              <ActionIcon
                disabled={!state.textBlock}
                aria-label={t(label)}
                aria-pressed={active}
                variant={active ? "light" : "subtle"}
                color={active ? "blue" : "gray"}
                size={36}
                radius="sm"
                onClick={action}
              >
                <Icon size={20} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          ))}
        </div>
        <Divider my={8} />
        <UnstyledButton
          className={classes.row}
          disabled={!state.textBlock}
          onClick={() => setPanel("typography")}
        >
          <Group gap={10} wrap="nowrap">
            <IconTypography size={18} />
            <Text size="sm" flex={1}>
              {t("Text formatting")}
            </Text>
            <IconChevronRight size={15} />
          </Group>
        </UnstyledButton>
        <UnstyledButton
          className={classes.row}
          disabled={!state.textBlock}
          onClick={() => setPanel("alignment")}
        >
          <Group gap={10} wrap="nowrap">
            <IconAlignLeft size={18} />
            <Text size="sm" flex={1}>
              {t("Indent and alignment")}
            </Text>
            <IconChevronRight size={15} />
          </Group>
        </UnstyledButton>
        <Divider my={8} />
        <BlockInsertPanel editor={editor} onClose={() => setAnchor(null)} />
      </>
    ) : (
      <>
        <UnstyledButton
          className={classes.back}
          autoFocus
          onClick={() => setPanel("main")}
          aria-label={t("Back")}
        >
          <Group gap={7}>
            <IconChevronLeft size={16} />
            <Text size="sm" fw={500}>
              {t(
                panel === "typography"
                  ? "Text formatting"
                  : "Indent and alignment",
              )}
            </Text>
          </Group>
        </UnstyledButton>
        <div className={classes.settings}>
          {panel === "typography" ? (
            <TextFormattingControls editor={editor} />
          ) : (
            <>
              <Group gap={6}>
                {(
                  [
                    ["Align left", "left", IconAlignLeft],
                    ["Align center", "center", IconAlignCenter],
                    ["Align right", "right", IconAlignRight],
                    ["Justify", "justify", IconAlignJustified],
                  ] as const
                ).map(([label, align, Icon]) => (
                  <Tooltip key={align} label={t(label)} withinPortal={false}>
                    <ActionIcon
                      aria-label={t(label)}
                      aria-pressed={state.align === align}
                      variant={state.align === align ? "light" : "subtle"}
                      size={36}
                      onClick={() =>
                        editor.chain().focus().setTextAlign(align).run()
                      }
                    >
                      <Icon size={20} />
                    </ActionIcon>
                  </Tooltip>
                ))}
              </Group>
              <Divider my="sm" />
              <Group gap={6}>
                <Tooltip label={t("Outdent")} withinPortal={false}>
                  <ActionIcon
                    aria-label={t("Outdent")}
                    variant="subtle"
                    size={36}
                    onClick={() => editor.chain().focus().outdent().run()}
                  >
                    <IconIndentDecrease size={20} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Indent")} withinPortal={false}>
                  <ActionIcon
                    aria-label={t("Indent")}
                    variant="subtle"
                    size={36}
                    onClick={() => editor.chain().focus().indent().run()}
                  >
                    <IconIndentIncrease size={20} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </>
          )}
        </div>
      </>
    );
  const onMenuMouseDown = (event: React.MouseEvent) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  };
  if (anchor && sidebar) {
    return (
      <Portal>
        <FocusTrap active>
          <section
            data-block-format-menu
            data-layout="sidebar"
            role="dialog"
            aria-label={t("Paragraph settings")}
            className={`${classes.panel} ${classes.sidebar}`}
            style={{
              left: sidebar.left,
              top: sidebar.top,
              height: sidebar.maxHeight,
              width: BLOCK_MENU_WIDTH,
            }}
            onMouseDown={onMenuMouseDown}
          >
            <Group justify="space-between" mb={8} wrap="nowrap">
              <Text size="sm" fw={600}>
                {t("Paragraph settings")}
              </Text>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("Close")}
                onClick={() => setAnchor(null)}
              >
                <IconX size={17} />
              </ActionIcon>
            </Group>
            {menuContents}
          </section>
        </FocusTrap>
      </Portal>
    );
  }
  return (
    <Portal>
      <Popover
        opened={!!anchor}
        onChange={(opened) => !opened && setAnchor(null)}
        position={placement.position}
        offset={8}
        middlewares={{ flip: false, shift: { padding: 8, crossAxis: false } }}
        width={BLOCK_MENU_WIDTH}
        shadow="md"
        radius="md"
        zIndex={250}
        trapFocus
      >
        <Popover.Target>
          <span
            aria-hidden
            style={{
              position: "fixed",
              left: placement.left,
              top: placement.top,
              width: placement.width,
              height: placement.height,
              pointerEvents: "none",
            }}
          />
        </Popover.Target>
        <Popover.Dropdown
          data-block-format-menu
          data-placement={placement.position}
          aria-label={t("Paragraph settings")}
          className={classes.panel}
          style={{
            maxHeight: placement.maxHeight,
            overflowY:
              panel === "main"
                ? placement.maxHeight < 360
                  ? "auto"
                  : "hidden"
                : placement.maxHeight < 240
                  ? "auto"
                  : "visible",
          }}
          onMouseDown={onMenuMouseDown}
        >
          {menuContents}
        </Popover.Dropdown>
      </Popover>
    </Portal>
  );
}
