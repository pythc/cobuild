import { FeishuService } from '../../server/modules/requirements/feishu.service';

describe('FeishuService documentContent', () => {
  it('resolves a docx link through Feishu OpenAPI only', async () => {
    const service = new FeishuService();
    const request = jest
      .fn()
      .mockResolvedValueOnce({ content: '技术方案正文' })
      .mockResolvedValueOnce({ document: { title: '技术方案' } });
    (service as unknown as { request: typeof request }).request = request;

    await expect(
      service.documentContent('https://example.feishu.cn/docx/doccn123'),
    ).resolves.toEqual({
      token: 'doccn123',
      title: '技术方案',
      content: '技术方案正文',
    });
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/docx/v1/documents/doccn123/raw_content',
      { retryableRead: true },
    );
  });

  it('rejects arbitrary external links before making a request', async () => {
    const service = new FeishuService();
    const request = jest.fn();
    (service as unknown as { request: typeof request }).request = request;

    await expect(
      service.documentContent('https://example.com/private/document'),
    ).rejects.toThrow('仅支持飞书云文档链接');
    expect(request).not.toHaveBeenCalled();
  });
});
