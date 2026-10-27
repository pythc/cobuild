import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { WorkflowDeliveryController } from '../../server/modules/notifications/notification-delivery.openapi.controller';
import { GitHubWebhookController } from '../../server/modules/pull-requests/github-webhook.openapi.controller';

const document = JSON.parse(readFileSync(join(__dirname, '../../docs/openapi.json'), 'utf8'));
describe('published operations OpenAPI contract', () => {
  it.each(['ingest','claim','result','reconcile'])('workflow %s declares the actual 200 status and handler name', (method) => {
    const entry = document.paths[`/openapi/workflow-deliveries/${method}`]?.post;
    expect(entry).toBeDefined();
    expect(entry.operationId).toBe(method);
    expect(entry.responses['200'].content['application/json'].schema.properties).toBeDefined();
    const handler = WorkflowDeliveryController.prototype[method as keyof WorkflowDeliveryController];
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });
  it('removes the retired probe while preserving the webhook contract', () => {
    expect(document.paths['/openapi/operations/probe']).toBeUndefined();
    const hook = document.paths['/openapi/github/webhook'].post;
    expect(hook.operationId).toBe('receive');
    expect(hook.responses['200'].content['application/json'].schema.properties).toHaveProperty('queued');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, GitHubWebhookController.prototype.receive)).toBe(200);
  });
});
