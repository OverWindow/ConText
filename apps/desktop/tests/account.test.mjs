import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AIConnections } from '../electron/ai-connections.mjs';
import { DesktopAccount } from '../electron/account.mjs';
import { accountProfile, sessionTokens } from '../electron/auth-profile.mjs';
const profile = { id: '10000000-0000-0000-0000-000000000001', email: 'same-web@example.test', display_name: '웹 사용자' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'context-account-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const storage = {
    available: async () => true,
    encrypt: async text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decrypt: async bytes => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); },
  };
  const calls = []; let offline = false, revoked = false, callback, challenge, hold, resolveHeld;
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (offline) throw new Error('offline');
    if (revoked) throw Object.assign(new Error('expired'), { status: 401 });
    if (url.endsWith('/api/desktop/auth/config')) return { supabase_url: 'https://auth.example.test', publishable_key: 'public-key' };
    if (url.includes('grant_type=pkce')) {
      const body = JSON.parse(init.body);
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge);
      return { access_token: 'sealed-access', refresh_token: 'sealed-refresh', expires_in: 3600 };
    }
    if (url.includes('grant_type=refresh_token')) return { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 };
    if (url.endsWith('/api/me')) { if (hold) { resolveHeld(); await hold; } return profile; }
    if (url.includes('/logout?scope=local')) return {};
    throw new Error('unexpected test request');
  };
  const openExternal = async url => {
    const authorize = new URL(url); assert.equal(authorize.searchParams.get('prompt'), 'select_account');
    callback = new URL(authorize.searchParams.get('redirect_to')); challenge = authorize.searchParams.get('code_challenge');
    callback.searchParams.set('code', 'single-use-code'); await fetch(callback);
  };
  const create = () => new AIConnections(directory, { secureStorage: storage, fetcher, openExternal });
  const connections = create(), account = new DesktopAccount(connections, { defaultServerBaseUrl: 'https://context.example.test' });
  return { directory, storage, connections, account, calls, create, fetcher, profile, offline: value => { offline = value; }, revoke: value => { revoked = value; }, callback: () => callback,
    hold: () => { let release; hold = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { resolveHeld = resolve; }); return { release: () => { release(); hold = null; }, entered }; } };
}

test('guest mode needs no server, credentials or secure storage', async t => {
  const f = await fixture(t);
  assert.equal((await f.account.status()).status, 'guest');
  assert.equal((await f.account.refresh()).user, null); assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(path.join(f.directory, 'ai-connection.enc')), { code: 'ENOENT' });
  f.storage.available = async () => false;
  assert.equal((await f.account.status()).status, 'unavailable');
  await assert.rejects(f.account.login(), /보안 저장소/);
  const invalidDefault = new DesktopAccount(f.connections, { defaultServerBaseUrl: 'not a URL' });
  assert.equal((await invalidDefault.status()).user, null);
});

test('login uses the verified web user ID, keeps personal AI settings and seals tokens outside the renderer', async t => {
  const f = await fixture(t);
  await f.connections.update({ mode: 'personal', model: 'own-model', api_key: 'personal-api-key' });
  const events = []; f.account.on('changed', state => events.push(state));
  const state = await f.account.login();
  assert.deepEqual(state.user, profile); assert.equal(state.status, 'signed_in');
  assert.equal((await f.connections.summary()).mode, 'personal');
  assert.equal((await f.connections.summary()).signed_in, true);
  const publicState = JSON.stringify(events);
  for (const secret of ['sealed-access', 'sealed-refresh', 'personal-api-key', 'code_verifier']) assert.equal(publicState.includes(secret), false);
  const ciphertext = await readFile(path.join(f.directory, 'ai-connection.enc'));
  assert.equal(ciphertext.includes('sealed-access'), false); assert.equal(ciphertext.includes(profile.email), false);
  const restarted = new DesktopAccount(f.create());
  assert.deepEqual((await restarted.status()).user, profile);
});

test('expired sessions rotate once and a legacy AI login gains the stable web profile', async t => {
  const f = await fixture(t); await f.account.login();
  const config = await f.connections.read(); delete config.session.user; config.session.expires_at = 1; await f.connections.persist(config);
  assert.equal((await f.account.status()).status, 'expired');
  await Promise.all([f.account.refresh(), f.account.refresh()]);
  assert.equal(f.calls.filter(c => c.url.includes('grant_type=refresh_token')).length, 1);
  assert.equal(f.calls.filter(c => c.url.endsWith('/api/me')).at(-1).init.headers.Authorization, 'Bearer rotated-access');
  assert.equal((await f.account.status()).status, 'signed_in');
  assert.deepEqual((await f.account.status()).user, profile);
});

test('offline refresh retains the account and revoked credentials request login without touching local data', async t => {
  const f = await fixture(t); await f.account.login();
  const localFile = path.join(f.directory, 'local-original.md'); await writeFile(localFile, '# 로컬 원본');
  f.offline(true); assert.equal((await f.account.refresh()).status, 'offline');
  assert.deepEqual((await f.account.status()).user, profile);
  f.offline(false); assert.equal((await f.account.refresh()).status, 'signed_in');
  f.revoke(true); assert.equal((await f.account.refresh()).status, 'expired');
  assert.equal(await readFile(localFile, 'utf8'), '# 로컬 원본');
});

test('logout revokes only this device, preserves personal keys and never resurrects a session after a late refresh', async t => {
  const f = await fixture(t); await f.connections.update({ mode: 'personal', model: 'own-model', api_key: 'personal-api-key' }); await f.account.login();
  const wait = f.hold(); const refresh = f.account.refresh(); await wait.entered;
  assert.equal((await f.account.logout()).status, 'guest'); wait.release(); await refresh;
  assert.equal((await f.account.status()).user, null);
  assert.equal((await f.connections.read()).session, null);
  assert.equal((await f.connections.summary()).has_personal_key, true);
  assert.ok(f.calls.some(c => c.url.endsWith('/logout?scope=local')));
});

test('changing server cancels pending login, clears only the shared account and rejects unsafe addresses', async t => {
  const f = await fixture(t); await f.account.login();
  await assert.rejects(f.account.configure('http://external.example.test'));
  await assert.rejects(f.account.configure('https://user:password@example.test'));
  await f.account.configure('https://another.example.test/');
  const config = await f.connections.read(); assert.equal(config.session, null); assert.equal(config.auth, null);
  assert.equal((await f.account.status()).serverBaseUrl, 'https://another.example.test');
});

test('invalid profiles and token lifetimes cannot become a logged-in web account', () => {
  for (const value of [null, { email: profile.email }, { ...profile, id: 'invented' }, { ...profile, email: '' }]) assert.throws(() => accountProfile(value));
  for (const value of [{}, { access_token: '', refresh_token: 'r', expires_in: 3600 }, { access_token: 'a', refresh_token: 'r', expires_at: 1 }]) assert.throws(() => sessionTokens(value));
});

test('cancelling while secure storage is being read prevents the browser from opening', async t => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.account.status.bind(f.account);
  f.account.status = async () => { entered(); await gate; return original(); };
  const login = f.account.login(); await waiting;
  f.account.cancel(); release();
  await assert.rejects(login, /취소/);
  assert.equal(f.calls.length, 0); assert.equal(f.callback(), undefined);
  assert.equal((await original()).status, 'guest');
});
