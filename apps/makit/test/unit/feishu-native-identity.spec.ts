import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { MakitIdentityRepository } from '../../server/common/selfhost/identity.repository';
import { FeishuService } from '../../server/modules/requirements/feishu.service';

describe('authoritative organization status and complete group membership', () => {
  function fixture() {
    const service=new FeishuService();
    const request=jest.spyOn(service as unknown as {request:()=>Promise<unknown>},'request');
    return {service,request};
  }
  it.each(['is_resigned','is_frozen','is_exited','is_activated'])('denies explicit %s account status instead of treating it as an outage', async (field) => {
    const {service,request}=fixture();
    request.mockResolvedValue({user:{union_id:'on_member',user_id:'employee',open_id:'ou_member',name:'Member',
      status:{[field]:field!=='is_activated'}}});
    await expect(service.getUserByUnionId('on_member')).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects a mismatched identity response', async () => {
    const {service,request}=fixture();request.mockResolvedValue({user:{union_id:'on_other',user_id:'employee',open_id:'ou_member',name:'Member'}});
    await expect(service.getUserByUnionId('on_member')).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('stops incomplete and cyclic group pagination', async () => {
    const missing=fixture();missing.request.mockResolvedValue({items:[],has_more:true});
    await expect(missing.service.listChatMemberIds('oc_group')).rejects.toBeInstanceOf(ServiceUnavailableException);
    const cycle=fixture();cycle.request.mockResolvedValue({items:[{member_id:'ou_member'}],has_more:true,page_token:'repeated'});
    await expect(cycle.service.listChatMemberIds('oc_group')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(cycle.request).toHaveBeenCalledTimes(2);
  });
  it('returns the complete ID list across valid pages', async () => {
    const {service,request}=fixture();request.mockResolvedValueOnce({items:[{member_id:'ou_first'}],has_more:true,page_token:'next'})
      .mockResolvedValueOnce({items:[{member_id:'ou_last'}],has_more:false});
    expect(await service.listChatMemberIds('oc_group')).toEqual(['ou_first','ou_last']);
  });
});

describe('Makit permission group member refresh', () => {
  function fixture(chats = ['oc_group']) {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      COBUILD_IDENTITY_MODE: 'feishu',
    });
    const policy = { chats };
    const register = jest.fn().mockResolvedValue(undefined);
    const identities = { policy: jest.fn().mockResolvedValue(policy), register };
    const service = new FeishuService(
      undefined,
      undefined,
      identities as unknown as MakitIdentityRepository,
    );
    const client = service as unknown as {
      request(method: string, path: string): Promise<unknown>;
    };
    jest.spyOn(client, 'request').mockImplementation(async (_method, path) => {
      const handle = path.split('/').pop()!;
      return {
        user: {
          union_id: handle,
          user_id: handle.slice(3),
          open_id: 'ou_' + handle.slice(3),
          name: handle,
          status: { is_activated: true },
        },
      };
    });
    const listMembers = jest.spyOn(service, 'listChatMemberIds');
    return { service, policy, listMembers, register };
  }

  afterEach(() => jest.restoreAllMocks());

  it('loads each group once for concurrent permission checks and evaluates each user separately', async () => {
    const { service, policy, listMembers, register } = fixture(['oc_first', 'oc_second']);
    listMembers.mockImplementation(async (id) =>
      id === 'oc_first' ? ['ou_first'] : ['ou_second'],
    );

    await Promise.all([
      service.getUserByUnionId('on_first'),
      service.getUserByUnionId('on_second'),
    ]);

    expect(listMembers.mock.calls).toEqual([['oc_first'], ['oc_second']]);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_first' }),
      ['oc_first'],
      policy,
    );
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_second' }),
      ['oc_second'],
      policy,
    );
  });

  it('refreshes membership at the existing deadline and observes removals and additions', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const { service, policy, listMembers, register } = fixture();
    listMembers.mockResolvedValueOnce(['ou_first']).mockResolvedValue(['ou_second']);

    await service.getUserByUnionId('on_first');
    now.mockReturnValue(159_999);
    await service.getUserByUnionId('on_first');
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({ openId: 'ou_first' }),
      ['oc_group'],
      policy,
    );

    now.mockReturnValue(160_000);
    await Promise.all([
      service.getUserByUnionId('on_first'),
      service.getUserByUnionId('on_second'),
    ]);
    expect(listMembers).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_first' }),
      [],
      policy,
    );
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_second' }),
      ['oc_group'],
      policy,
    );
  });

  it('rejects concurrent checks after a failed refresh and retries without using expired members', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const { service, policy, listMembers, register } = fixture();
    const unavailable = new ServiceUnavailableException('Feishu unavailable');
    listMembers
      .mockResolvedValueOnce(['ou_member'])
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue([]);
    await service.getUserByUnionId('on_member');
    register.mockClear();

    now.mockReturnValue(160_000);
    await expect(Promise.allSettled([
      service.getUserByUnionId('on_member'),
      service.getUserByUnionId('on_member'),
    ])).resolves.toEqual([
      { status: 'rejected', reason: unavailable },
      { status: 'rejected', reason: unavailable },
    ]);
    expect(register).not.toHaveBeenCalled();
    expect(listMembers).toHaveBeenCalledTimes(2);

    await service.getUserByUnionId('on_member');
    expect(listMembers).toHaveBeenCalledTimes(3);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_member' }),
      [],
      policy,
    );
  });
});
