import { axiosForBackend } from '../../client/src/lib/selfhost-http';
import {
  getAccess,
  getRecords,
  getReviews,
  getRoles,
  changeMember,
  getWorkflowNotifications,
} from '../../client/src/api/operations';

jest.mock('../../client/src/lib/selfhost-http', () => ({
  axiosForBackend: jest.fn(),
}));
const transport = axiosForBackend as jest.Mock;

describe('operations API contract', () => {
  beforeEach(() => transport.mockReset());

  it('reads records without taking an actor identity from the caller', async () => {
    transport.mockResolvedValue({ status: 200, data: { items: [] } });
    await expect(
      getRecords({ scope: 'mine', page: 1, pageSize: 25 }),
    ).resolves.toEqual({ items: [] });
    expect(transport).toHaveBeenCalledWith({
      url: '/api/operations/records',
      method: 'GET',
      params: { scope: 'mine', page: 1, pageSize: 25 },
      signal: undefined,
    });
  });

  it('uses the exact read endpoints and delta-only membership mutation', async () => {
    transport.mockResolvedValue({ status: 200, data: {} });
    await getAccess();
    await getRoles();
    await getReviews({ page: 2 });
    await getWorkflowNotifications({ page: 1 });
    await changeMember({ userId: 'selected-user', action: 'add' });
    expect(
      transport.mock.calls.map(([input]) => [input.method, input.url]),
    ).toEqual([
      ['GET', '/api/operations/access'],
      ['GET', '/api/operations/roles'],
      ['GET', '/api/operations/ai-reviews'],
      ['GET', '/api/operations/workflow-notifications'],
      ['POST', '/api/operations/roles/members'],
    ]);
    expect(transport.mock.calls[4][0].data).toEqual({
      userId: 'selected-user',
      action: 'add',
    });
  });

  it.each([401, 403])('fails closed for status %i', async (status) => {
    transport.mockRejectedValue({
      response: { status, data: { message: 'private detail' } },
    });
    await expect(getAccess()).rejects.toThrow('无权查看或修改此内容');
  });

  it('preserves localized errors from the global exception envelope', async () => {
    transport.mockRejectedValue({
      response: { status: 400, data: { error: { message: '请选择有效成员' } } },
    });
    await expect(changeMember({ userId: '', action: 'add' })).rejects.toThrow(
      '请选择有效成员',
    );
  });
});
