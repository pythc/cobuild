import { GoneException } from '@nestjs/common';
import { RelayDispatcher } from '../../server/modules/relay/relay.controller';
import type { Request, Response } from 'express';
import type { CurrentUserSummary } from '../../shared/api.interface';
describe('retired hosted Relay write routes', () => {
  it.each(['POST', 'PATCH', 'DELETE'])('%s cannot write a second hosted conversation state', async (method: string) => {
    const service = {begin: jest.fn(),send: jest.fn(),update: jest.fn()};
    const dispatcher = new RelayDispatcher(service as never);
    await expect(dispatcher.dispatch('/relay/conversations',
      {method,headers:{}} as Request,
      {setHeader:jest.fn()} as unknown as Response,
      {},{} as CurrentUserSummary,
    )).rejects.toBeInstanceOf(GoneException);
    expect(service.begin).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });
});
