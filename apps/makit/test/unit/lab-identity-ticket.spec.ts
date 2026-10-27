import { generateKeyPairSync } from 'node:crypto';
import {
  sealTicket,
  openTicket,
  validTicketInput,
} from '../../server/modules/requirements/lab-identity-ticket';
describe('first native platform consent ticket', () => {
  const old = process.env.MCP_PERSONAL_TOKEN_SECRET;
  beforeEach(() => {
    process.env.MCP_PERSONAL_TOKEN_SECRET =
      'fictional-private-key-for-ticket-2026';
  });
  afterEach(() => {
    process.env.MCP_PERSONAL_TOKEN_SECRET = old;
    jest.restoreAllMocks();
  });
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    input = () => ({
      token: 't'.repeat(43),
      publicKey: pair.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url'),
      requestNonce: 'n'.repeat(22),
      state: 's'.repeat(43),
      redirectUri: 'http://127.0.0.1:9876/callback/110lab_requirements',
    });
  test('contains no plaintext grant and is bound to the server key and expiry', () => {
    const v = input(),
      sealed = sealTicket(v);
    expect(sealed).not.toContain(v.token);
    expect(openTicket(sealed)).toMatchObject(v);
    process.env.MCP_PERSONAL_TOKEN_SECRET = 'other-fictional-private-key-2026';
    expect(() => openTicket(sealed)).toThrow();
  });
  test('rejects tampering, expiration and non-loopback redirect tricks', () => {
    const v = input(),
      sealed = sealTicket(v);
    expect(() => openTicket(sealed.slice(0, -4) + 'xxxx')).toThrow();
    const time = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(time + 601000);
    expect(() => openTicket(sealed)).toThrow();
    for (const redirectUri of [
      'https://attacker.example/callback',
      'http://127.0.0.1.evil:9876/callback/110lab_requirements',
      'http://user@127.0.0.1:9876/callback/110lab_requirements',
      'http://127.0.0.1:9876/callback/other',
    ])
      expect(() => validTicketInput({ ...v, redirectUri })).toThrow();
  });
});
