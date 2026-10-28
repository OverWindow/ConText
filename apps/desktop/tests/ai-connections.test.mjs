import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AIConnections, serverURL, fetchJSON } from '../electron/ai-connections.mjs';

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-ai-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const key = randomBytes(32);
  const secureStorage = {
    available: async () => true,
    encrypt: async text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt: async bytes => { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  return { base, ai: new AIConnections(base, { secureStorage, openExternal: async () => {}, ...options }) };
}

test('personal key is sealed, never returned, used only for the selected gateway and removable', async t => {
  const requests = [];
  const f = await fixture(t, { fetcher: async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/models/')) return { data: [{ id: 'model-one', type: 'llm' }, { id: 'image', type: 'image' }, { id: 'gpt-codex', type: 'llm' }] };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '초안', blocks: [{ id: 'p', type: 'paragraph', text: '본문', source_ids: [] }], checks: [] }) } }] };
  } });
  const state = await f.ai.update({ mode: 'personal', model: 'model-one', api_key: 'my-private-key' });
  assert.equal(state.has_personal_key, true);
  assert.equal(JSON.stringify(state).includes('my-private-key'), false);
  assert.equal((await readFile(path.join(f.base, 'ai-connection.enc'))).includes('my-private-key'), false);
  assert.deepEqual(await f.ai.models(), [{ id: 'model-one', name: 'model-one' }]);
  const generated = await f.ai.generate({ task: 'write', request_id: 'local-request', prompt: '문서 작성', sources: [] });
  assert.equal(generated.content.title, '초안');
  assert.equal(requests.at(-1).init.headers.Authorization, 'Bearer my-private-key');
  await f.ai.removePersonal();
  assert.equal((await f.ai.summary()).has_personal_key, false);
});

test('missing secure storage rejects key storage without writing plaintext', async t => {
  const f = await fixture(t, { secureStorage: { available: async () => false } });
  await assert.rejects(f.ai.update({ mode: 'personal', model: '', api_key: 'not-stored-key' }));
  await assert.rejects(readFile(path.join(f.base, 'ai-connection.enc')), { code: 'ENOENT' });
  assert.throws(() => serverURL('http://external.example.test'));
  assert.throws(() => serverURL('https://user:password@example.test'));
  assert.equal(serverURL('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
});

test('managed login uses loopback PKCE, verifies the account and never exposes tokens', async t => {
  let challenge, redirected, exchange, receivedBearer;
  const f = await fixture(t, {
    openExternal: async target => {
      const url = new URL(target); challenge = url.searchParams.get('code_challenge');
      redirected = new URL(url.searchParams.get('redirect_to'));
      assert.equal(redirected.hostname, '127.0.0.1');
      const wrong = new URL('/callback/wrong?code=bad', redirected);
      assert.equal((await fetch(wrong)).status, 404);
      redirected.searchParams.set('code', 'test-auth-code'); await fetch(redirected);
    },
    fetcher: async (url, init) => {
      if (url.endsWith('/api/desktop/auth/config')) return { supabase_url: 'https://auth.example.test', publishable_key: 'public-test-key' };
      if (url.includes('grant_type=pkce')) {
        exchange = JSON.parse(init.body);
        assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), challenge);
        return { access_token: 'private-access', refresh_token: 'private-refresh', expires_at: Date.now() / 1000 + 3600 };
      }
      if (url.endsWith('/api/me')) return { id: '00000000-0000-0000-0000-000000000001', email: 'user@example.test', display_name: '사용자' };
      if (url.includes('/api/ai/models?mode=managed')) { receivedBearer = init.headers.Authorization; return [{ id: 'managed-model', name: '서버 모델' }]; }
      if (url.endsWith('/api/ai/context')) {
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'managed-model'); assert.equal(body.connection, 'managed');
        assert.equal(body.messageId, undefined); assert.equal(body.evidence, undefined);
        assert.equal(body.sources[0].chunk_id, undefined); assert.equal(body.sources[0].relative_path, undefined);
        return { claims: [{ text: '검증한 답변', source_ids: ['source-1'] }], insufficient: false };
      }
      throw new Error('Unexpected request');
    },
  });
  await f.ai.update({ mode: 'managed', model: 'managed-model', serverBaseUrl: 'https://context.example.test' });
  const state = await f.ai.login();
  assert.equal(exchange.auth_code, 'test-auth-code');
  assert.equal(state.signed_in, true); assert.equal(state.email, 'user@example.test');
  assert.equal(JSON.stringify(state).includes('private-access'), false);
  assert.equal((await f.ai.models())[0].id, 'managed-model');
  assert.equal(receivedBearer, 'Bearer private-access');
  const result = await f.ai.generate({ request_id: 'request', task: 'chat', prompt: '질문', messageId: 'internal-message', evidence: {}, sources: [{ id: 'source-1', document_title: '자료', text: '근거', chunk_id: 'internal-chunk', relative_path: 'internal/path' }] });
  assert.equal(result.claims[0].text, '검증한 답변');
  assert.equal((await f.ai.logout()).signed_in, false);
});

test('personal requests send only whitelisted excerpts and concurrent credential edits do not resurrect keys', async t => {
  let sent;
  const f = await fixture(t, { fetcher: async (url, init) => {
    if (url.endsWith('/models/')) return { data: [{ id: 'personal', type: 'llm' }] };
    sent = JSON.parse(init.body);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [], insufficient: true }) } }] };
  } });
  await f.ai.update({ mode: 'personal', model: 'personal', api_key: 'test-private-key' });
  await f.ai.generate({ request_id: 'request', task: 'chat', prompt: '질문', sources: [{ id: 'source', document_title: '자료', text: '근거', relative_path: '/private/internal/path', chunk_id: 'internal-index' }] });
  const payload = JSON.stringify(sent);
  assert.equal(payload.includes('/private/internal/path'), false); assert.equal(payload.includes('internal-index'), false);
  await Promise.all([f.ai.update({ mode: 'managed', model: 'next-model' }), f.ai.removePersonal()]);
  assert.equal((await f.ai.summary()).has_personal_key, false);
});

test('cancelling loopback login closes the listener and never stores a session', async t => {
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  let redirect;
  const f = await fixture(t, { openExternal: async url => { redirect = new URL(new URL(url).searchParams.get('redirect_to')); opened(); }, fetcher: async () => ({ supabase_url: 'https://auth.example.test', publishable_key: 'public-key' }) });
  await f.ai.update({ mode: 'managed', model: '', serverBaseUrl: 'https://context.example.test' });
  const login = f.ai.login(); await ready; f.ai.cancelLogin();
  await assert.rejects(login, /취소/);
  assert.equal((await f.ai.summary()).signed_in, false);
  await assert.rejects(fetch(redirect));
});

test('HTTPS server callback returns through the app URI with PKCE and matching request state', async t => {
  let challenge, exchange, appURL, receivedProfile = false;
  const f = await fixture(t, {
    openExternal: async target => {
      const authorize = new URL(target), redirect = new URL(authorize.searchParams.get('redirect_to'));
      challenge = authorize.searchParams.get('code_challenge');
      assert.equal(redirect.origin, 'https://context.example.test');
      assert.match(redirect.pathname, /^\/api\/desktop\/auth\/callback\/[a-f0-9]{48}$/);
      const state = redirect.pathname.split('/').at(-1);
      appURL = `context-desktop://auth/callback?state=${state}&code=server-auth-code`;
      assert.equal(f.ai.handleLoginCallback(appURL.replace(state, 'b'.repeat(48))), false);
      assert.equal(f.ai.handleLoginCallback(appURL.replace('context-desktop:', 'https:')), false);
      assert.equal(f.ai.handleLoginCallback(appURL + '&code=second'), false);
      assert.equal(f.ai.handleLoginCallback(appURL), true);
      assert.equal(f.ai.handleLoginCallback(appURL), false);
    },
    fetcher: async (url, init) => {
      if (url.endsWith('/config')) return { supabase_url: 'https://auth.example.test', publishable_key: 'synthetic-key', desktop_callback_path: '/api/desktop/auth/callback' };
      if (url.includes('grant_type=pkce')) {
        exchange = JSON.parse(init.body);
        assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), challenge);
        return { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 };
      }
      if (url.endsWith('/api/me')) { receivedProfile = true; return { id: '00000000-0000-0000-0000-000000000001', email: 'user@example.test' }; }
      throw new Error('Unexpected request');
    },
  });
  await f.ai.update({ mode: 'managed', model: '', serverBaseUrl: 'https://context.example.test' });
  const result = await f.ai.login();
  assert.equal(result.signed_in, true); assert.equal(receivedProfile, true);
  assert.equal(exchange.auth_code, 'server-auth-code');
  assert.equal(appURL.includes(exchange.code_verifier), false);
  assert.equal(JSON.stringify(result).includes('private-access'), false);
});

test('server callback cancellation and stale app links never create a session', async t => {
  let opened, appURL;
  const ready = new Promise(resolve => { opened = resolve; });
  const f = await fixture(t, {
    openExternal: async target => { const redirect = new URL(new URL(target).searchParams.get('redirect_to')); appURL = `context-desktop://auth/callback?state=${redirect.pathname.split('/').at(-1)}&code=stale`; opened(); },
    fetcher: async url => { assert.ok(url.endsWith('/config')); return { supabase_url: 'https://auth.example.test', publishable_key: 'synthetic-key', desktop_callback_path: '/api/desktop/auth/callback' }; },
  });
  assert.equal(f.ai.handleLoginCallback('context-desktop://auth/callback?code=orphan'), false);
  await f.ai.update({ mode: 'managed', model: '', serverBaseUrl: 'https://context.example.test' });
  const login = f.ai.login(); await ready;
  f.ai.cancelLogin(); await assert.rejects(login, { code: 'AUTH_LOGIN_CANCELLED' });
  assert.equal(f.ai.handleLoginCallback(appURL), false);
  assert.equal((await f.ai.summary()).signed_in, false);
});

test('provider denial through the server app link ends only the pending login', async t => {
  const f = await fixture(t, {
    openExternal: async target => { const redirect = new URL(new URL(target).searchParams.get('redirect_to')); assert.equal(f.ai.handleLoginCallback(`context-desktop://auth/callback?state=${redirect.pathname.split('/').at(-1)}&error=access_denied`), true); },
    fetcher: async url => { assert.ok(url.endsWith('/config')); return { supabase_url: 'https://auth.example.test', publishable_key: 'synthetic-key', desktop_callback_path: '/api/desktop/auth/callback' }; },
  });
  await f.ai.update({ mode: 'managed', model: '', serverBaseUrl: 'https://context.example.test' });
  await assert.rejects(f.ai.login(), /취소했거나/);
  assert.equal((await f.ai.summary()).signed_in, false);
});


test('gateway errors distinguish credits, permissions and unsupported requests without exposing upstream bodies', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const [status, code] of [[401, 'AI_FORBIDDEN'], [429, 'AI_RATE_LIMITED'], [422, 'AI_UNSUPPORTED_REQUEST']]) {
    globalThis.fetch = async () => new Response('private-upstream-response', { status });
    await assert.rejects(fetchJSON('https://gateway.example.test'), error => error.code === code && !error.message.includes('private-upstream-response'));
  }
  globalThis.fetch = async () => new Response('invalid json', { status: 200 });
  await assert.rejects(fetchJSON('https://gateway.example.test'), { code: 'AI_INVALID_RESPONSE' });
});
