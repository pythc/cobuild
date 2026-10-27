import * as Y from 'yjs';
import { applyReview as applySigned, reviewSelection } from './review-yjs';
const applyReview = (doc: Y.Doc, value: any) =>
  applySigned(doc, value, 'isolated-test-secret');
function fixture() {
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph'),
    text = new Y.XmlText();
  doc.getXmlFragment('default').insert(0, [p]);
  p.insert(0, [text]);
  text.insert(0, '部署失败直接重试。', { bold: true });
  const selection = {
    anchor: Y.createRelativePositionFromTypeIndex(text, 0),
    head: Y.createRelativePositionFromTypeIndex(text, 8),
  };
  return { doc, text, selection };
}
describe('review decisions on live Yjs text', () => {
  it('accepts selected text, retains formatting, and is idempotent', () => {
    const f = fixture(),
      r = reviewSelection(f.doc, f.selection);
    const v = {
      id: 'one',
      selection: f.selection,
      fingerprint: r.fingerprint,
      replacement: '部署失败时回退',
      actorId: 'editor',
    };
    applyReview(f.doc, v);
    applyReview(f.doc, v);
    expect(
      f.text
        .toDelta()
        .map((d) => d.insert)
        .join(''),
    ).toBe('部署失败时回退。');
    expect(f.text.toDelta()[0].attributes.bold).toBe(true);
  });
  it('detects concurrent text changes', () => {
    const f = fixture(),
      r = reviewSelection(f.doc, f.selection);
    f.text.insert(2, '再次');
    expect(() =>
      applyReview(f.doc, {
        id: 'two',
        selection: f.selection,
        fingerprint: r.fingerprint,
        replacement: '不覆盖新内容',
        actorId: 'editor',
      }),
    ).toThrow('原文或格式已变化');
  });
  it('detects format-only changes', () => {
    const f = fixture(),
      r = reviewSelection(f.doc, f.selection);
    f.text.format(1, 1, { italic: true });
    expect(() =>
      applyReview(f.doc, {
        id: 'format',
        selection: f.selection,
        fingerprint: r.fingerprint,
        replacement: '建议',
        actorId: 'editor',
      }),
    ).toThrow();
  });
  it('rejection prevents subsequent acceptance', () => {
    const f = fixture(),
      v = {
        id: 'r',
        selection: f.selection,
        fingerprint: reviewSelection(f.doc, f.selection).fingerprint,
        replacement: '修改',
        actorId: 'editor',
      };
    const receipt = applyReview(f.doc, { ...v, decision: 'rejected' });
    expect(applyReview(f.doc, v)).toEqual(receipt);
    expect(
      f.text
        .toDelta()
        .map((d) => d.insert)
        .join(''),
    ).toBe('部署失败直接重试。');
  });
  it('a durable accepted receipt cannot become rejected', () => {
    const f = fixture(),
      v = {
        id: 'a',
        selection: f.selection,
        fingerprint: reviewSelection(f.doc, f.selection).fingerprint,
        replacement: '回退',
        actorId: 'editor',
      };
    applyReview(f.doc, v);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(f.doc));
    expect(
      (applyReview(restored, { ...v, decision: 'rejected' }) as any).decision,
    ).toBe('accepted');
  });
  it('rejects a selection from another document', () => {
    const f = fixture();
    expect(() => reviewSelection(new Y.Doc(), f.selection)).toThrow();
  });
  it('keeps anchors across changes outside the selection', () => {
    const f = fixture(),
      r = reviewSelection(f.doc, f.selection);
    f.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    expect(reviewSelection(f.doc, f.selection).fingerprint).toBe(r.fingerprint);
  });
  it('refuses a receipt forged by an editing client', () => {
    const f = fixture(),
      r = reviewSelection(f.doc, f.selection);
    f.doc
      .getMap('weknow-review-receipts')
      .set('forged', {
        decision: 'accepted',
        actorId: 'someone-else',
        appliedAt: new Date().toISOString(),
        signature: '0'.repeat(64),
      });
    expect(() =>
      applyReview(f.doc, {
        id: 'forged',
        selection: f.selection,
        fingerprint: r.fingerprint,
        replacement: '覆盖',
        actorId: 'editor',
      }),
    ).toThrow('回执校验失败');
  });
});
