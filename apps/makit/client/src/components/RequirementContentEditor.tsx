import { useMemo, useRef } from 'react';
import { Extension } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import { Plugin } from '@tiptap/pm/state';
import { TiptapEditorComplete } from '@/components/business-ui/tiptap-editor';
import {
  hasMarkdownFormatting,
  parseRequirementContent,
  requirementMarkdownHtml,
} from '@/lib/requirement-utils';

const MarkdownInput = Extension.create({
  name: 'requirementMarkdownInput',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            if (!view.editable || view.state.selection.$from.parent.type.spec.code) return false;
            const text = event.clipboardData?.getData('text/plain');
            const html = event.clipboardData?.getData('text/html') || '';
            if (
              !text ||
              /data-pm-slice=|<(?:h[1-6]|table|ul|ol|img|a)(?:\s|>)/iu.test(html) ||
              !hasMarkdownFormatting(text)
            ) return false;
            return editor.commands.insertContent(requirementMarkdownHtml(text));
          },
          handleDOMEvents: {
            blur() {
              if (editor.isEditable) {
                const content = parseRequirementContent(editor.getHTML());
                if (content.format === 'markdown') {
                  editor.commands.setContent(requirementMarkdownHtml(content.value));
                }
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

const extensions = [
  TableKit.configure({ table: { renderWrapper: true } }),
  MarkdownInput,
];

export function RequirementContentEditor({
  value,
  onValueChange,
  placeholder,
  className,
  readOnly = false,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
}) {
  const editedHtml = useRef<string>(undefined);
  const html = useMemo(() => {
    // Leave the selection in place when the form echoes the editor's own HTML.
    if (value === editedHtml.current) return value;
    const content = parseRequirementContent(value);
    return content.format === 'richText'
      ? content.value
      : requirementMarkdownHtml(content.value) || '<p></p>';
  }, [value]);

  return (
    <TiptapEditorComplete
      value={html}
      onValueChange={(content) => {
        editedHtml.current = content;
        onValueChange?.(content);
      }}
      placeholder={placeholder}
      className={className}
      readOnly={readOnly}
      additionalExtensions={extensions}
    />
  );
}
