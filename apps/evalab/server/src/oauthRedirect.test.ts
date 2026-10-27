import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesOAuthRedirect, validOAuthRedirect } from './oauth.js';

test('loopback authorization accepts ephemeral ports while preserving the registered callback', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    for (const ports of [['', ':49152'], [':49152', ':65535'], [':80', '']]) {
      assert.equal(matchesOAuthRedirect(`http://${host}${ports[1]}/oauth/callback?client=exam`,
        `http://${host}${ports[0]}/oauth/callback?client=exam`), true);
    }
  }
  assert.equal(matchesOAuthRedirect('https://agent.example:8443/cb?a=1', 'https://agent.example:8443/cb?a=1'), true);
});

test('the port exception cannot change hosts, schemes, credentials, paths or query bytes', () => {
  const registered = 'http://127.0.0.1:1234/oauth/callback?client=exam';
  for (const requested of [
    'http://localhost:5678/oauth/callback?client=exam',
    'http://[::1]:5678/oauth/callback?client=exam',
    'http://127.0.0.2:5678/oauth/callback?client=exam',
    'http://127.0.0.1.evil.example:5678/oauth/callback?client=exam',
    'http://2130706433:5678/oauth/callback?client=exam',
    'https://127.0.0.1:5678/oauth/callback?client=exam',
    'http://name:secret@127.0.0.1:5678/oauth/callback?client=exam',
    'http://127.0.0.1:5678/oauth/other?client=exam',
    'http://127.0.0.1:5678/other/../oauth/callback?client=exam',
    'http://127.0.0.1:5678/oauth/%63allback?client=exam',
    'http://127.0.0.1:5678/oauth/callback?client=other',
    'http://127.0.0.1:5678/oauth/callback?client=exam&extra=1',
    'http://127.0.0.1:5678/oauth/callback?client=exam#',
    'http://127.0.0.1:5678/oauth/callback?client=exam#fragment',
    'http://127.0.0.1:5678/oauth/callback?client=ex\tam',
    'http://127.0.0.1:70000/oauth/callback?client=exam',
  ]) assert.equal(matchesOAuthRedirect(requested, registered), false, requested);
  for (const host of ['agent.example', '127.0.0.1', '[::1]', 'localhost']) {
    assert.equal(matchesOAuthRedirect(`https://${host}:5678/cb`, `https://${host}:1234/cb`), false);
  }
});

test('registration rejects custom schemes and unsafe callback forms', () => {
  for (const value of [
    'workbuddy://workbuddy/mcp/custom-mcp%3A110-lab-assessment/oauth/callback',
    'file:///tmp/callback', 'javascript:alert(1)', 'not a URL',
    'http://203.0.113.1/cb', 'https://name:secret@agent.example/cb',
    'https://agent.example/cb#', 'https://agent.example/cb#fragment',
    ' https://agent.example/cb', 'https://agent.example/ca\tllback',
    'https://agent.example/\\callback',
  ]) assert.equal(validOAuthRedirect(value), false, value);
});
