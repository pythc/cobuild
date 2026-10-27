import { z } from 'zod';
export const messageInput = z
  .object({
    content: z.string().max(10000).default(''),
    private: z.boolean().default(false),
    attachments: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            kind: z.string().max(80),
            size: z.string().max(80),
            id: z.string().max(128).optional(),
            url: z.string().max(8000000).optional(),
            content: z.string().max(20000).optional(),
            data: z.string().max(8000000).optional(),
          })
          .strict(),
      )
      .max(3)
      .default([]),
  })
  .strict();
export const createInput = z
  .object({
    conversationId: z.string().min(1).max(128),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20000).default(''),
    priority: z.enum(['较低', '普通', '紧急']),
    handlerIds: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
export const updateInput = z
  .object({
    status: z.enum(['待分派', '处理中', '待补充', '已解决', '已关闭']),
    handlerIds: z.array(z.string().min(1).max(128)).max(50),
    note: z.string().trim().max(20000).default(''),
    revision: z.union([z.number(), z.string(), z.null()]),
    reply: z.literal('').optional(),
  })
  .strict();
