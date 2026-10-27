import * as Y from 'yjs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function reviewSelection(doc: Y.Doc, selection: any) {
  let a: Y.AbsolutePosition | null, b: Y.AbsolutePosition | null;
  try {
    a = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(selection.anchor),
      doc,
    );
    b = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(selection.head),
      doc,
    );
  } catch {
    throw new BadRequestException('请选择一段连续正文');
  }
  if (!a || !b || a.type !== b.type || !(a.type instanceof Y.XmlText))
    throw new ConflictException('原文位置已变化，请重新选择');
  let parent: any = a.type;
  while (parent.parent) parent = parent.parent;
  if (parent !== doc.getXmlFragment('default'))
    throw new BadRequestException('请选择文档正文');
  const from = Math.min(a.index, b.index),
    to = Math.max(a.index, b.index);
  if (to <= from || to - from > 8000)
    throw new BadRequestException('请选择 1 至 8000 个字符');
  const deltas: any[] = [];
  let at = 0;
  for (const d of a.type.toDelta()) {
    if (typeof d.insert !== 'string')
      throw new BadRequestException('暂不支持包含嵌入内容的修订');
    const end = at + d.insert.length;
    if (end > from && at < to)
      deltas.push({
        insert: d.insert.slice(
          Math.max(0, from - at),
          Math.min(d.insert.length, to - at),
        ),
        attributes: Object.fromEntries(
          Object.entries(d.attributes || {}).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      });
    at = end;
  }
  const text = deltas.map((d) => d.insert).join('');
  if (text.length !== to - from) throw new ConflictException('原文已变化');
  return {
    type: a.type,
    from,
    to,
    text,
    attributes: deltas[0]?.attributes || {},
    fingerprint: createHash('sha256').update(canonical(deltas)).digest('hex'),
  };
}

export function applyReview(
  doc: Y.Doc,
  value: {
    id: string;
    selection: any;
    fingerprint: string;
    replacement: string;
    actorId: string;
    pageId?: string;
    decision?: 'accepted' | 'rejected';
  },
  key: string,
) {
  const receipts = doc.getMap('weknow-review-receipts');
  const sign = (receipt: any) =>
    createHmac('sha256', key)
      .update(
        canonical({
          pageId: value.pageId || '',
          id: value.id,
          fingerprint: value.fingerprint,
          decision: receipt.decision,
          actorId: receipt.actorId,
          appliedAt: receipt.appliedAt,
        }),
      )
      .digest('hex');
  if (receipts.has(value.id)) {
    const saved: any = receipts.get(value.id);
    if (
      !saved ||
      !['accepted', 'rejected'].includes(saved.decision) ||
      typeof saved.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(saved.signature) ||
      !timingSafeEqual(
        Buffer.from(sign(saved), 'hex'),
        Buffer.from(saved.signature, 'hex'),
      )
    )
      throw new ConflictException('修订回执校验失败，请联系管理员核对');
    return saved;
  }
  let range: ReturnType<typeof reviewSelection> | null = null;
  if (value.decision !== 'rejected') {
    try {
      range = reviewSelection(doc, value.selection);
    } catch {
      throw new ConflictException('原文位置已变化，请重新提出建议');
    }
  }
  if (range && range.fingerprint !== value.fingerprint)
    throw new ConflictException('原文或格式已变化，请重新提出建议');
  const receipt = {
    decision: value.decision || 'accepted',
    actorId: value.actorId,
    appliedAt: new Date().toISOString(),
  };
  const signed = { ...receipt, signature: sign(receipt) };
  doc.transact(() => {
    if (range) {
      range.type.delete(range.from, range.to - range.from);
      if (value.replacement)
        range.type.insert(range.from, value.replacement, range.attributes);
    }
    receipts.set(value.id, signed);
  });
  return signed;
}
