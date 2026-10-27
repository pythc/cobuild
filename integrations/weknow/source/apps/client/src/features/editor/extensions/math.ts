import { InputRule, type CommandProps } from "@tiptap/core";
import {
  NodeSelection,
  TextSelection,
  Plugin,
  type EditorState,
} from "@tiptap/pm/state";
import { Fragment } from "@tiptap/pm/model";
import {
  MathBlock as BaseMathBlock,
  MathInline as BaseMathInline,
} from "@docmost/editor-ext";

// Select the inserted atom explicitly. insertContent may otherwise place the
// caret in an adjacent text block, leaving an empty equation without its editor.
function insertEquation(
  name: string,
  attributes: Record<string, unknown> = {},
) {
  return ({ commands, tr, dispatch }: CommandProps) => {
    if (!commands.insertContent({ type: name, attrs: attributes }))
      return false;
    if (dispatch) {
      const map = tr.mapping.maps[tr.mapping.maps.length - 1];
      let position: number | undefined;
      map?.forEach((_from, _to, from, to) => {
        tr.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === name) {
            position = pos;
            return false;
          }
        });
      });
      if (position !== undefined)
        tr.setSelection(NodeSelection.create(tr.doc, position));
    }
    return true;
  };
}

function replaceParagraph(state: EditorState, text: string) {
  const { $from } = state.selection;
  const from = $from.before();
  const equation = state.schema.nodes.mathBlock.create({ text });
  const paragraph = state.schema.nodes.paragraph.create();
  const parent = $from.node(-1);
  const index = $from.index(-1);
  let content = [equation, paragraph];
  let prefixSize = 0;
  // List items require their first child to remain a paragraph.
  if (!parent.canReplace(index, index + 1, Fragment.fromArray(content))) {
    content = [paragraph, equation, paragraph];
    prefixSize = paragraph.nodeSize;
    if (!parent.canReplace(index, index + 1, Fragment.fromArray(content)))
      return null;
  }
  const tr = state.tr.replaceWith(from, $from.after(), content);
  tr.setSelection(
    TextSelection.create(tr.doc, from + prefixSize + equation.nodeSize + 1),
  );
  return tr.scrollIntoView();
}

export const MathBlock = BaseMathBlock.extend({
  priority: 110,
  addCommands() {
    return {
      setMathBlock: (attributes = {}) => insertEquation(this.name, attributes),
    };
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (
          !this.editor.isEditable ||
          view.composing ||
          !empty ||
          $from.parent.type.name !== "paragraph" ||
          $from.parentOffset !== $from.parent.content.size ||
          $from.parent.childCount !== 1 ||
          !$from.parent.firstChild?.isText ||
          $from.parent.firstChild.marks.some(
            (mark) => mark.type.name === "code",
          )
        )
          return false;
        // Only a whole paragraph is promoted. Inline expressions and incomplete
        // delimiters continue to behave like ordinary text.
        const match = /^\s*\$\$(?!\$)([\s\S]*?[^$])\$\$\s*$/.exec(
          $from.parent.textContent,
        );
        if (!match || !match[1].trim()) return false;
        const tr = replaceParagraph(state, match[1].trim());
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput: (view, from, to, text) => {
            const $from = view.state.doc.resolve(from);
            const $to = view.state.doc.resolve(to);
            if (
              view.composing ||
              !this.editor.isEditable ||
              !$from.sameParent($to) ||
              $from.parent.type.name !== "paragraph" ||
              $from.marks().some((mark) => mark.type.name === "code")
            )
              return false;
            const before = $from.parent.textBetween(0, $from.parentOffset);
            if (!/^\s*\$\$/.test(before + text)) return false;
            // Keep LaTeX literal until Enter. Typography/Markdown shortcuts would
            // otherwise rewrite ^2, --, quotes and underscores before conversion.
            view.dispatch(view.state.tr.insertText(text, from, to));
            return true;
          },
        },
      }),
    ];
  },
  // Keep the existing triple-dollar shortcut, without stripping escaped dollars
  // from the TeX source.
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\$((?:[^$]|\\\$)+)\$\$\$$/,
        handler: ({ state, match }) => {
          if (state.selection.$from.parent.type.name !== "paragraph")
            return null;
          const transaction = replaceParagraph(state, match[1]);
          // InputRule state exposes the shared transaction; no separate dispatch.
          return transaction ? undefined : null;
        },
      }),
    ];
  },
});

export const MathInline = BaseMathInline.extend({
  addCommands() {
    return {
      setMathInline: (attributes = {}) => insertEquation(this.name, attributes),
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|\s)(\$\$(?!\$)((?:[^$]|\\\$)+)\$\$)$/,
        handler: ({ state, range, match }) => {
          const start = range.from + match[0].lastIndexOf(match[1]);
          const $start = state.doc.resolve(start);
          // A standalone $$...$$ belongs to the Enter block shortcut; don't
          // consume it as inline math while typing the closing delimiter.
          if (
            $start.parent.type.name === "paragraph" &&
            !$start.parent.textBetween(0, $start.parentOffset).trim()
          )
            return null;
          state.tr.replaceWith(
            start,
            range.to,
            this.type.create({ text: match[2] }),
          );
        },
      }),
    ];
  },
});
