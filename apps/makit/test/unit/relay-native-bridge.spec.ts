import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { RelayNativeController } from '../../server/modules/relay/relay-native.controller';
import { LabIdentityService } from '../../server/modules/requirements/lab-identity.service';
import { RelayIntakeService } from '../../server/modules/requirements/relay-intake.service';
import { RequirementsCommandService } from '../../server/modules/requirements/requirements-command.service';
import type { CurrentUserSummary } from '../../shared/api.interface';

describe('independent Relay native Makit bridge', () => {
  const actor: CurrentUserSummary = {
    employeeId: 'staff',
    openId: 'ou_staff',
    name: 'Staff',
    miaodaUserId: 'member',
    platformAppId: 'app',
  };
  const identity = { actor: jest.fn(async () => actor) };
  const intake = {
    members: jest.fn(async () => ({ members: [] })),
    create: jest.fn(),
    get: jest.fn(),
    group: jest.fn(),
  };
  const command = { updateRequirementAs: jest.fn() };
  const controller = new RelayNativeController(
    identity as unknown as LabIdentityService,
    intake as unknown as RelayIntakeService,
    command as unknown as RequirementsCommandService,
  );
  const originalFetch = global.fetch;
  const originalKey = process.env.RELAY_NATIVE_SERVICE_KEY;
  const key = 'k'.repeat(43),
    token = 't'.repeat(43);
  const request = (given: string): Request =>
    ({
      headers: { 'x-relay-native-key': given },
    }) as unknown as Request;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELAY_NATIVE_SERVICE_KEY = key;
  });
  afterAll(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.RELAY_NATIVE_SERVICE_KEY;
    else process.env.RELAY_NATIVE_SERVICE_KEY = originalKey;
  });
  it('rejects an invalid machine key before inspecting any personal token', async () => {
    await expect(
      controller.dispatch(request('wrong'), {
        action: 'members',
        token,
        input: {},
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(identity.actor).not.toHaveBeenCalled();
  });
  it('uses the Relay audience instead of accepting a requirements credential', async () => {
    await controller.dispatch(request(key), {
      action: 'members',
      token,
      input: {},
    });
    expect(identity.actor).toHaveBeenCalledWith(token, 'relay');
    expect(intake.members).toHaveBeenCalledWith(actor);
  });
  it('rejects mutations for a member outside the workbench operator range', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ allowed: false }), { status: 200 }),
    );
    await expect(
      controller.dispatch(request(key), {
        action: 'create',
        token,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(intake.create).not.toHaveBeenCalled();
  });
  it('does not mutate a ticket when the authority cannot be reached', async () => {
    global.fetch = jest.fn(async () => {
      throw Error('offline');
    });
    await expect(
      controller.dispatch(request(key), {
        action: 'group',
        token,
        input: { conversationId: 'cw_1_1' },
      }),
    ).rejects.toThrow('客服权限暂时无法核对');
    expect(intake.group).not.toHaveBeenCalled();
  });
  it('passes the unchanged frozen context to native idempotent creation', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    );
    const input = {
      conversationId: 'cw_1_1',
      messages: [{ content: 'context' }],
    };
    await controller.dispatch(request(key), { action: 'create', token, input });
    expect(intake.create).toHaveBeenCalledWith(input, actor);
  });
});
