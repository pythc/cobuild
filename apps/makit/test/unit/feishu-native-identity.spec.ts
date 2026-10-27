import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
