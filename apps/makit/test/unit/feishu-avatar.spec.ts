import { FeishuService } from '../../server/modules/requirements/feishu.service';
describe('Feishu avatar retrieval', () => {
  it('coalesces concurrent requests, caches actual URLs and never fabricates an avatar', async () => {
    const service = new FeishuService();
    const request = jest
      .fn()
      .mockResolvedValue({
        user: { avatar: { avatar_240: 'https://cdn.example/avatar.png' } },
      });
    Object.defineProperty(service, 'request', { value: request });
    expect(
      await Promise.all([
        service.getAvatarByOpenId('ou_fixtureperson'),
        service.getAvatarByOpenId('ou_fixtureperson'),
      ]),
    ).toEqual([
      'https://cdn.example/avatar.png',
      'https://cdn.example/avatar.png',
    ]);
    await service.getAvatarByOpenId('ou_fixtureperson');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('validates identifiers, rejects unsafe URLs and allows retry after a provider failure', async () => {
    const service = new FeishuService();
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({
        user: { avatar: { avatar_240: 'javascript:unsafe' } },
      });
    Object.defineProperty(service, 'request', { value: request });
    await expect(service.getAvatarByOpenId('../outside')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(service.getAvatarByOpenId('ou_fixtureperson')).rejects.toThrow(
      'unavailable',
    );
    expect(await service.getAvatarByOpenId('ou_fixtureperson')).toBe('');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
