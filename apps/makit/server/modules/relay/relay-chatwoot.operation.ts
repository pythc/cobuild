import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { ChatwootError } from './chatwoot-client';
import type { RelayChatwootStore } from './relay-chatwoot.store';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
function operationMarker(principal: string, op: string, key: string) {
  z.string()
    .regex(/^[\w-]{8,100}$/)
    .parse(key);
  return digest(principal + '|' + op + '|' + key);
}
export async function runRelayOperation<T>(
  store: RelayChatwootStore,
  principal: string,
  op: string,
  key: string,
  payload: unknown,
  action: (marker: string) => Promise<T>,
  reconcile: (marker: string) => Promise<T | null>,
): Promise<T> {
  const marker = operationMarker(principal, op, key),
    { row, claimed } = await store.reserve(
      marker,
      digest(JSON.stringify(payload)),
    );
  if (!claimed) {
    if (row.state === 'done') return JSON.parse(row.response_json!);
    if (['unknown', 'writing'].includes(row.state)) {
      const found = await reconcile(marker);
      if (found) {
        await store.done(row, found);
        return found;
      }
    }
    throw new ConflictException(
      '操作结果仍在核对，未重复发送，请使用原请求重试查询',
    );
  }
  await store.writing(row);
  try {
    const result = await action(marker);
    await store.done(row, result);
    return result;
  } catch (e) {
    await store.fail(row, e instanceof ChatwootError && e.rejected);
    throw e;
  }
}
