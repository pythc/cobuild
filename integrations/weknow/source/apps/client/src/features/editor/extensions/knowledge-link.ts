import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import {
  getPageById,
  getAttachmentInfo,
} from "@/features/page/services/page-service";
import {
  parseKnowledgeLink,
  type KnowledgeLinkTarget,
} from "../components/link/knowledge-link-target";

type Pending = { from: number; to: number; href: string; text: string };
export const knowledgeLinkKey = new PluginKey<Map<string, Pending>>(
  "knowledgeLinkResolution",
);
export const KnowledgeLinks = Extension.create({
  name: "knowledgeLinks",
  priority: 1100,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: knowledgeLinkKey,
        props: {
          handlePaste: (_view, event) => {
            if (
              this.editor.isActive("codeBlock") ||
              this.editor.isActive("code")
            )
              return false;
            const text = event.clipboardData?.getData("text/plain");
            if (!text || !insertKnowledgeLink(this.editor, text)) return false;
            event.preventDefault();
            return true;
          },
        },
        state: {
          init: () => new Map(),
          apply(tr, previous) {
            const next = new Map<string, Pending>();
            for (const [id, range] of previous) {
              const from = tr.mapping.mapResult(range.from, 1);
              const to = tr.mapping.mapResult(range.to, -1);
              if (!from.deletedAcross && !to.deletedAcross && from.pos < to.pos)
                next.set(id, { ...range, from: from.pos, to: to.pos });
            }
            const change = tr.getMeta(knowledgeLinkKey);
            if (change?.add) next.set(change.id, change.add);
            if (change?.remove) next.delete(change.remove);
            return next;
          },
        },
      }),
    ];
  },
});

export async function resolveKnowledgeLink(target: KnowledgeLinkTarget) {
  if (target.kind === "page") {
    const page = await getPageById({
      pageId: target.id,
      includeContent: false,
    } as any);
    return {
      title: page.title || "Untitled",
      type: page.nodeType || "page",
      ext: page.fileExtension,
      isBase: page.isBase,
      page,
    };
  }
  const attachment = await getAttachmentInfo(target.id);
  return {
    title: attachment.fileName,
    type: "file",
    ext: attachment.fileExt,
    isBase: false,
  };
}

// Insert a normal link immediately. Resolve its title against a mapped range so
// slow requests cannot overwrite typing, undo, a different link or another page.
export function insertKnowledgeLink(editor: Editor, url: string) {
  const target = parseKnowledgeLink(url, window.location.origin);
  if (!target || !editor.isEditable || editor.isDestroyed) return false;
  const { from, to } = editor.state.selection;
  const id = crypto.randomUUID();
  const mark = editor.schema.marks.link.create({
    href: target.href,
    internal: true,
  });
  const tr = editor.state.tr.replaceWith(
    from,
    to,
    editor.schema.text(url.trim(), [mark]),
  );
  tr.setSelection(TextSelection.create(tr.doc, from + url.trim().length));
  tr.setMeta(knowledgeLinkKey, {
    id,
    add: {
      from,
      to: from + url.trim().length,
      href: target.href,
      text: url.trim(),
    },
  });
  editor.view.dispatch(tr);
  editor.view.focus();
  void resolveKnowledgeLink(target)
    .then((result) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      const range = knowledgeLinkKey.getState(editor.state)?.get(id);
      if (!range) return;
      const tr = editor.state.tr.setMeta(knowledgeLinkKey, { remove: id });
      let matches =
        editor.state.doc.textBetween(range.from, range.to) === range.text;
      editor.state.doc.nodesBetween(range.from, range.to, (node) => {
        if (
          node.isText &&
          !node.marks.some(
            (m) => m.type.name === "link" && m.attrs.href === range.href,
          )
        )
          matches = false;
      });
      if (matches && result.title)
        tr.replaceWith(
          range.from,
          range.to,
          editor.schema.text(result.title, [mark]),
        );
      editor.view.dispatch(tr.setMeta("addToHistory", false));
    })
    .catch(() => {
      if (!editor.isDestroyed)
        editor.view.dispatch(
          editor.state.tr
            .setMeta(knowledgeLinkKey, { remove: id })
            .setMeta("addToHistory", false),
        );
    });
  return true;
}
