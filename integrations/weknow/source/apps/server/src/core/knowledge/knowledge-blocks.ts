import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import {
  jsonToNode,
  prosemirrorNodeToYElement,
} from '../../collaboration/collaboration.util';

export function boundedValue(value: any) {
  let count = 0;
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const x = stack.pop()!;
    if (++count > 30000 || x.depth > 40)
      throw new BadRequestException('Content structure exceeds the limit');
    if (x.value && typeof x.value === 'object')
      for (const child of Object.values(x.value))
        stack.push({ value: child, depth: x.depth + 1 });
  }
  return value;
}
export function stableJson(value: any): string {
  boundedValue(value);
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}
export const revision = (value: any) =>
  createHash('sha256').update(stableJson(value)).digest('hex');
export function liveContent(doc: Y.Doc) {
  return TiptapTransformer.fromYdoc(doc, 'default');
}
export function validateDocument(doc: any) {
  boundedValue(doc);
  if (doc?.type !== 'doc')
    throw new BadRequestException('Content must be a ProseMirror document');
  if (!doc.content?.length) doc.content = [{ type: 'paragraph' }];
  const visit = (n: any) => {
    for (const [k, v] of Object.entries(n.attrs || {})) {
      if (
        ['href', 'src', 'url'].includes(k) &&
        typeof v === 'string' &&
        v &&
        !/^(?:https?:\/\/|mailto:|\/|#)/i.test(v)
      )
        throw new BadRequestException('Unsupported content URL');
    }
    for (const child of n.content || []) visit(child);
    for (const mark of n.marks || []) visit(mark);
  };
  visit(doc);
  try {
    const node = jsonToNode(doc);
    node.check();
    return node;
  } catch {
    throw new BadRequestException('Content does not match the editor schema');
  }
}
export function blockList(doc: any) {
  const out: any[] = [];
  const visit = (node: any, path: number[]) => {
    const pm = jsonToNode({ type: 'doc', content: [node] });
    if (pm.firstChild?.isBlock) {
      out.push({
        blockId: 'b:' + path.join('.'),
        type: node.type,
        depth: path.length - 1,
        node,
      });
      for (const [i, child] of (node.content || []).entries())
        if (child.type !== 'text') visit(child, [...path, i]);
    }
  };
  for (const [i, n] of (doc.content || []).entries()) visit(n, [i]);
  return out;
}
function pathOf(id: any) {
  if (typeof id !== 'string' || !/^b:(?:\d+\.)*\d+$/.test(id))
    throw new BadRequestException('blockId is required');
  const p = id.slice(2).split('.').map(Number);
  if (p.some((v) => !Number.isSafeInteger(v) || v > 10000))
    throw new BadRequestException('Invalid blockId');
  return p;
}
function locate(doc: any, path: number[]) {
  let node = doc;
  for (const index of path.slice(0, -1)) {
    node = node.content?.[index];
    if (!node) throw new BadRequestException('Block not found');
  }
  const index = path[path.length - 1];
  if (
    !node.content?.[index] ||
    !jsonToNode({ type: 'doc', content: [node.content[index]] }).firstChild
      ?.isBlock
  )
    throw new BadRequestException('Block not found');
  return { parent: node, index, node: node.content[index] };
}
function replaceTexts(
  node: any,
  find: string,
  replacement: string,
  all: boolean,
  counter: { n: number },
) {
  if (typeof node.text === 'string' && (all || counter.n === 0)) {
    let index = node.text.indexOf(find);
    while (index >= 0 && (all || counter.n === 0)) {
      node.text =
        node.text.slice(0, index) +
        replacement +
        node.text.slice(index + find.length);
      counter.n++;
      if (counter.n > 10000)
        throw new BadRequestException('Too many replacements');
      index = all ? node.text.indexOf(find, index + replacement.length) : -1;
    }
  }
  for (const c of node.content || [])
    replaceTexts(c, find, replacement, all, counter);
}
export function previewPatches(source: any, patches: any[]) {
  const doc = structuredClone(source);
  let replacements = 0;
  for (const p of patches) {
    const nodes = p.prosemirrorJson?.content || [];
    switch (p.operation) {
      case 'append':
        doc.content.push(...nodes);
        break;
      case 'prepend':
        doc.content.unshift(...nodes);
        break;
      case 'replace_document':
        doc.content = nodes;
        break;
      case 'replace_text': {
        if (!p.find || typeof p.replace !== 'string')
          throw new BadRequestException('find and replace required');
        const target = p.blockId ? locate(doc, pathOf(p.blockId)).node : doc;
        const counter = { n: 0 };
        replaceTexts(target, p.find, p.replace, !!p.all, counter);
        if (!counter.n)
          throw new BadRequestException(
            'Text match not found; use a block edit for matches spanning text marks',
          );
        replacements += counter.n;
        break;
      }
      default: {
        const at = locate(doc, pathOf(p.blockId));
        if (p.operation === 'delete_block')
          at.parent.content.splice(at.index, 1);
        else if (p.operation === 'replace_block')
          at.parent.content.splice(at.index, 1, ...nodes);
        else if (p.operation === 'insert_before')
          at.parent.content.splice(at.index, 0, ...nodes);
        else if (p.operation === 'insert_after')
          at.parent.content.splice(at.index + 1, 0, ...nodes);
        else throw new BadRequestException('Unsupported patch');
      }
    }
  }
  validateDocument(doc);
  return { doc, replacements };
}
function yParent(doc: Y.Doc, path: number[]) {
  let node: any = doc.getXmlFragment('default');
  for (const index of path.slice(0, -1)) {
    node = node.get(index);
    if (!(node instanceof Y.XmlElement))
      throw new BadRequestException('Block structure changed');
  }
  return { parent: node, index: path[path.length - 1] };
}
function yTextReplace(
  node: any,
  find: string,
  replacement: string,
  all: boolean,
  counter: { n: number },
) {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText && (all || counter.n === 0)) {
      // XmlText.toString() includes XML mark tags. Match plain delta runs instead, in
      // the same marked text boundaries used by ProseMirror's preview validation.
      let cursor = 0;
      const matches: { at: number; attributes: any }[] = [];
      for (const delta of child.toDelta()) {
        if (typeof delta.insert === 'string') {
          let at = delta.insert.indexOf(find);
          while (at >= 0 && (all || counter.n + matches.length === 0)) {
            matches.push({
              at: cursor + at,
              attributes: delta.attributes || {},
            });
            if (counter.n + matches.length > 10000)
              throw new BadRequestException('Too many replacements');
            at = all ? delta.insert.indexOf(find, at + find.length) : -1;
          }
          cursor += delta.insert.length;
        } else cursor++;
      }
      for (const match of matches.reverse()) {
        child.delete(match.at, find.length);
        if (replacement) child.insert(match.at, replacement, match.attributes);
      }
      counter.n += matches.length;
    } else if (child instanceof Y.XmlElement && (all || counter.n === 0))
      yTextReplace(child, find, replacement, all, counter);
  }
}
/** All validation and revision checks happen before the synchronous Yjs mutation. */
function mutateY(doc: Y.Doc, patches: any[]) {
  let replacements = 0;
  const root = doc.getXmlFragment('default');
  for (const p of patches) {
    const nodes = p.prosemirrorJson?.content || [];
    if (p.operation === 'append' || p.operation === 'prepend')
      root.insert(
        p.operation === 'prepend' ? 0 : root.length,
        nodes.map(prosemirrorNodeToYElement),
      );
    else if (p.operation === 'replace_document') {
      if (root.length) root.delete(0, root.length);
      root.insert(0, nodes.map(prosemirrorNodeToYElement));
    } else if (p.operation === 'replace_text') {
      const target = p.blockId
        ? (() => {
            const at = yParent(doc, pathOf(p.blockId));
            return at.parent.get(at.index);
          })()
        : root;
      const c = { n: 0 };
      yTextReplace(target, p.find, p.replace, !!p.all, c);
      replacements += c.n;
    } else {
      const at = yParent(doc, pathOf(p.blockId));
      if (p.operation === 'delete_block') at.parent.delete(at.index, 1);
      else if (p.operation === 'replace_block') {
        at.parent.delete(at.index, 1);
        at.parent.insert(at.index, nodes.map(prosemirrorNodeToYElement));
      } else
        at.parent.insert(
          at.index + (p.operation === 'insert_after' ? 1 : 0),
          nodes.map(prosemirrorNodeToYElement),
        );
    }
  }
  if (root.length === 0)
    root.insert(0, [prosemirrorNodeToYElement({ type: 'paragraph' })]);
  return replacements;
}
export function applyLivePatches(doc: Y.Doc, expected: string, patches: any[]) {
  const before = liveContent(doc);
  if (revision(before) !== expected)
    throw new ConflictException(
      'revision_conflict: read the current document before retrying',
    );
  previewPatches(before, patches);
  const clone = new Y.Doc();
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    clone.transact(() => mutateY(clone, patches));
    validateDocument(liveContent(clone));
  } finally {
    clone.destroy();
  }
  const replacements = mutateY(doc, patches);
  return { revision: revision(liveContent(doc)), replacements };
}
