import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { CurrentUserSummary } from '../../../shared/api.interface';
import { ChatwootClient, ChatwootError } from './chatwoot-client';
import type { RelayChatwootStore } from './relay-chatwoot.store';
import { runRelayOperation } from './relay-chatwoot.operation';
import { messageInput } from './relay-chatwoot.input';
export async function sendRelayMessage(
  chat: ChatwootClient,
  store: RelayChatwootStore,
  principal: string,
  remoteId: number,
  id: string,
  actor: CurrentUserSummary,
  body: unknown,
  key: string,
  operator: boolean,
) {
  const input = messageInput.parse(body);
  if (!input.content.trim() && !input.attachments.length)
    throw new BadRequestException('请填写消息');
  if (!operator && input.private)
    throw new ForbiddenException('不能发送内部备注');
  // Decode and validate before claiming: invalid local input is a known rejection.
  const files = input.attachments.map((f) => {
    const raw = f.data || f.url || '';
    const match =
      /^data:([\w.+/-]+)(;charset=utf-8)?(;base64)?,([\s\S]*)$/.exec(raw);
    if (!match) throw new BadRequestException('附件格式无效');
    let bytes: Buffer;
    try {
      if (match[3]) {
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            match[4],
          )
        )
          throw new Error();
        bytes = Buffer.from(match[4], 'base64');
      } else {
        if (!/^text\//.test(match[1])) throw new Error();
        bytes = Buffer.from(decodeURIComponent(match[4]), 'utf8');
      }
    } catch {
      throw new BadRequestException('附件格式无效');
    }

    if (bytes.length > 5 * 1024 * 1024 || !bytes.length)
      throw new BadRequestException('单个附件不能超过 5 MB');
    return { name: f.name.replace(/[\r\n/\\]/g, '_'), mime: match[1], bytes };
  });
  if (
    files.reduce((total, file) => total + file.bytes.length, 0) >
    6 * 1024 * 1024
  )
    throw new BadRequestException('附件合计不能超过 6 MB');
  const find = async (marker: string) => {
    const m = (await chat.messages(remoteId)).find(
      (m: any) => m.content_attributes?.relay_request_id === marker,
    );
    return m ? { id: String(m.id) } : null;
  };
  return runRelayOperation(
    store,
    principal,
    'message:' + id,
    key,
    { input, operator },
    async (marker) => {
      const attrs = {
        relay_request_id: marker,
        relay_sender_name: actor.name,
        relay_sender_employee_id: actor.employeeId,
      };
      let v: any;
      if (files.length) {
        const form = new FormData();
        form.append('content', input.content);
        form.append('message_type', operator ? 'outgoing' : 'incoming');
        form.append('private', String(input.private));
        form.append('content_attributes', JSON.stringify(attrs));
        for (const f of files)
          form.append(
            'attachments[]',
            new Blob([new Uint8Array(f.bytes)], { type: f.mime }),
            f.name,
          );
        v = await chat.request(
          chat.account(`/conversations/${remoteId}/messages`),
          { method: 'POST', form },
        );
      } else
        v = await chat.request(
          chat.account(`/conversations/${remoteId}/messages`),
          {
            method: 'POST',
            body: {
              content: input.content,
              message_type: operator ? 'outgoing' : 'incoming',
              private: input.private,
              content_attributes: attrs,
            },
          },
        );
      if (!Number.isSafeInteger(v.id)) throw new ChatwootError(false);
      return { id: String(v.id) };
    },
    find,
  );
}
