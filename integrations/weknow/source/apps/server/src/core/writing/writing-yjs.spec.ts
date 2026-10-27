import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';

describe('writing attribution from real collaborative documents', () => {
  function fixture() {
    const document = TiptapTransformer.toYdoc(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '你好' }] },
        ],
      },
      'default',
      tiptapExtensions,
    );
    const paragraph = document.getXmlFragment('default').get(0) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    const extension = new PersistenceExtension(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    return { document, text, extension };
  }
  test('interleaved browser and Agent transactions retain separate actor deltas', async () => {
    const { document, text, extension } = fixture();
    const documentName = 'page.fixture';
    await extension.afterLoadDocument({ document, documentName } as any);
    document.transact(() => text.insert(2, '世界'));
    await extension.onChange({
      document,
      documentName,
      context: { user: { id: 'browser-user' } },
    } as any);
    document.transact(() => text.insert(4, '！'));
    await extension.onChange({
      document,
      documentName,
      context: { user: { id: 'agent-user' }, knowledgeDurable: true },
    } as any);
    const rows = (extension as any).writing.take(documentName);
    expect(rows.map((row) => [row.userId, row.charsDelta])).toEqual([
      ['browser-user', 2],
      ['agent-user', 1],
    ]);
    document.destroy();
  });
  test('read-only synchronization does not grant authorship or inflate a later writer', async () => {
    const { document, text, extension } = fixture();
    const documentName = 'page.fixture';
    await extension.afterLoadDocument({ document, documentName } as any);
    document.transact(() => text.insert(2, '同步'));
    await extension.onChange({
      document,
      documentName,
      context: { user: { id: 'reader' }, knowledgeReadOnly: true },
    } as any);
    document.transact(() => text.insert(4, '写作'));
    await extension.onChange({
      document,
      documentName,
      context: { user: { id: 'writer' } },
    } as any);
    const rows = (extension as any).writing.take(documentName);
    expect(rows.map((row) => [row.userId, row.charsDelta])).toEqual([
      ['writer', 2],
    ]);
    document.destroy();
  });
});
