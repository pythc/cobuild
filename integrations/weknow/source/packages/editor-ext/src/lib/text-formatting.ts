import { Extension } from '@tiptap/core';
import type {} from '@tiptap/extension-text-style';

export const TEXT_FONTS = ['sans-serif', 'serif', 'monospace'] as const;

export function validFontSize(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?px$/.test(value)) return null;
  const size = parseFloat(value);
  return size >= 10 && size <= 72 ? `${size}px` : null;
}

export function validLineHeight(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
  const height = Number(value);
  return height >= 1 && height <= 3 ? String(height) : null;
}

function validFont(value: unknown): string | null {
  return TEXT_FONTS.includes(value as (typeof TEXT_FONTS)[number])
    ? (value as string)
    : null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textFormatting: {
      setTextSize: (size: string | null) => ReturnType;
      setTextFont: (font: string | null) => ReturnType;
      setParagraphLineHeight: (height: string | null) => ReturnType;
    };
  }
}

// Shared by the browser, collaboration server and HTML export. Keeping the
// attributes in one schema prevents a save/export from silently dropping them.
export const TextFormatting = Extension.create({
  name: 'textFormatting',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => validFontSize(element.style.fontSize),
            renderHTML: (attrs) =>
              validFontSize(attrs.fontSize)
                ? { style: `font-size: ${validFontSize(attrs.fontSize)}` }
                : {},
          },
          fontFamily: {
            default: null,
            parseHTML: (element) => validFont(element.style.fontFamily),
            renderHTML: (attrs) =>
              validFont(attrs.fontFamily)
                ? { style: `font-family: ${validFont(attrs.fontFamily)}` }
                : {},
          },
        },
      },
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: {
            default: null,
            keepOnSplit: true,
            parseHTML: (element) => validLineHeight(element.style.lineHeight),
            renderHTML: (attrs) =>
              validLineHeight(attrs.lineHeight)
                ? { style: `line-height: ${validLineHeight(attrs.lineHeight)}` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTextSize:
        (size) =>
        ({ chain }) => {
          if (size !== null && !validFontSize(size)) return false;
          return chain()
            .setMark('textStyle', { fontSize: validFontSize(size) })
            .removeEmptyTextStyle()
            .run();
        },
      setTextFont:
        (font) =>
        ({ chain }) => {
          if (font !== null && !validFont(font)) return false;
          return chain()
            .setMark('textStyle', { fontFamily: validFont(font) })
            .removeEmptyTextStyle()
            .run();
        },
      setParagraphLineHeight:
        (height) =>
        ({ tr, dispatch }) => {
          if (height !== null && !validLineHeight(height)) return false;
          let found = false;
          tr.doc.nodesBetween(
            tr.selection.from,
            tr.selection.to,
            (node, pos) => {
              if (!['paragraph', 'heading'].includes(node.type.name))
                return true;
              found = true;
              if (dispatch)
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  lineHeight: validLineHeight(height),
                });
              return false;
            },
          );
          return found;
        },
    };
  },
});
