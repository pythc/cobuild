import assert from 'node:assert/strict';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { Challenge } from 'altcha-lib/types';

type Api = { fetch(path: string, init?: RequestInit): Promise<{ status: number; data: any; text: string }> };

/** Exercise the same proof and signed browser cookie flow as the real registration form. */
export async function registrationProof(api: Api, email: string): Promise<string> {
  const response = await api.fetch(`/api/auth/registration-challenge?email=${encodeURIComponent(email)}`);
  assert.equal(response.status, 200, response.text);
  const challenge = response.data as Challenge;
  const solution = await solveChallenge({ challenge, deriveKey, timeout: 60_000 });
  assert.ok(solution, 'registration proof must be solved');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

export function mergeCookies(previous: string, pair: string): string {
  const cookies = new Map(previous.split('; ').filter(Boolean).map((value) => [value.split('=')[0], value]));
  cookies.set(pair.split('=')[0], pair);
  return [...cookies.values()].join('; ');
}
