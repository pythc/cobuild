import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import {
  applyLivePatches,
  liveContent,
  revision,
  blockList,
  validateDocument,
} from './knowledge-blocks';

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const content = (...nodes: any[]) => ({ type: 'doc', content: nodes });
describe('knowledge live document edits', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = TiptapTransformer.toYdoc(
      content(paragraph('第一段'), paragraph('保留段')),
      'default',
      tiptapExtensions,
    );
  });
  afterEach(() => doc.destroy());
  const patch = (operation: string, extra: any = {}) => ({
    operation,
    ...extra,
  });
  test('local block replacement preserves the other Yjs node identity', () => {
    const untouched = doc.getXmlFragment('default').get(1),
      before = revision(liveContent(doc));
    applyLivePatches(doc, before, [
      patch('replace_block', {
        blockId: 'b:0',
        prosemirrorJson: content(paragraph('已修改')),
      }),
    ]);
    expect(doc.getXmlFragment('default').get(1)).toBe(untouched);
    expect(liveContent(doc).content[0].content[0].text).toBe('已修改');
  });
  test('stale revisions cannot overwrite concurrent changes', () => {
    const before = revision(liveContent(doc));
    applyLivePatches(doc, before, [
      patch('append', { prosemirrorJson: content(paragraph('新段')) }),
    ]);
    const after = revision(liveContent(doc));
    expect(() =>
      applyLivePatches(doc, before, [
        patch('delete_block', { blockId: 'b:0' }),
      ]),
    ).toThrow('revision_conflict');
    expect(revision(liveContent(doc))).toBe(after);
  });
  test('a later invalid patch leaves all earlier edits unapplied', () => {
    const before = revision(liveContent(doc));
    expect(() =>
      applyLivePatches(doc, before, [
        patch('prepend', { prosemirrorJson: content(paragraph('临时')) }),
        patch('delete_block', { blockId: 'b:999' }),
      ]),
    ).toThrow();
    expect(revision(liveContent(doc))).toBe(before);
  });
  test('deleting the last block creates a valid empty document', () => {
    applyLivePatches(doc, revision(liveContent(doc)), [
      patch('delete_block', { blockId: 'b:1' }),
      patch('delete_block', { blockId: 'b:0' }),
    ]);
    expect(liveContent(doc).content).toHaveLength(1);
    expect(() => validateDocument(liveContent(doc))).not.toThrow();
  });
  test('text replacement supports CJK and preserves unaffected blocks', () => {
    const second = doc.getXmlFragment('default').get(1);
    const v = applyLivePatches(doc, revision(liveContent(doc)), [
      patch('replace_text', { find: '第一', replace: '更新' }),
    ]);
    expect(v.replacements).toBe(1);
    expect(doc.getXmlFragment('default').get(1)).toBe(second);
    expect(liveContent(doc).content[0].content[0].text).toBe('更新段');
  });
  test('marked text matches plain deltas and keeps its formatting', () => {
    doc.destroy();
    doc = TiptapTransformer.toYdoc(
      content({
        type: 'paragraph',
        content: [
          { type: 'text', text: '开头 ' },
          { type: 'text', text: '第一段 第一段', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' 结尾' },
        ],
      }),
      'default',
      tiptapExtensions,
    );
    const v = applyLivePatches(doc, revision(liveContent(doc)), [
      patch('replace_text', { find: '第一段', replace: '更新', all: true }),
    ]);
    expect(v.replacements).toBe(2);
    const middle = liveContent(doc).content[0].content.find((n) =>
      n.marks?.some((m) => m.type === 'bold'),
    );
    expect(middle.text).toBe('更新 更新');
  });
  test('nested list blocks use stable paths for the returned revision', () => {
    doc.destroy();
    doc = TiptapTransformer.toYdoc(
      content({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('条目')] }],
      }),
      'default',
      tiptapExtensions,
    );
    expect(blockList(liveContent(doc)).map((v) => v.blockId)).toEqual([
      'b:0',
      'b:0.0',
      'b:0.0.0',
    ]);
    applyLivePatches(doc, revision(liveContent(doc)), [
      patch('replace_block', {
        blockId: 'b:0.0.0',
        prosemirrorJson: content(paragraph('更新')),
      }),
    ]);
    expect(
      liveContent(doc).content[0].content[0].content[0].content[0].text,
    ).toBe('更新');
  });
  test('inline paths are not accepted as block IDs', () => {
    expect(() =>
      applyLivePatches(doc, revision(liveContent(doc)), [
        patch('delete_block', { blockId: 'b:0.0' }),
      ]),
    ).toThrow();
  });
  test('invalid child structures cannot partially mutate live content', () => {
    const before = revision(liveContent(doc));
    expect(() =>
      applyLivePatches(doc, before, [
        patch('replace_block', {
          blockId: 'b:0',
          prosemirrorJson: content({ type: 'text', text: 'not a block' }),
        }),
      ]),
    ).toThrow();
    expect(revision(liveContent(doc))).toBe(before);
  });
  test.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])(
    'unsafe link marks are rejected: %s',
    (href) => {
      expect(() =>
        validateDocument(
          content({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '链接',
                marks: [{ type: 'link', attrs: { href } }],
              },
            ],
          }),
        ),
      ).toThrow();
    },
  );
});
