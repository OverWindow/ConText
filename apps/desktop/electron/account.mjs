import { EventEmitter } from 'node:events';
import { serverURL } from './ai-connections.mjs';
import { accountProfile } from './auth-profile.mjs';

// Reuse the existing sealed session so general login and managed AI have one account.
// No local workspace is owned by this session, and no file upload is started here.
export class DesktopAccount extends EventEmitter {
  constructor(connections, { defaultServerBaseUrl = 'http://127.0.0.1:8000' } = {}) {
    super(); this.connections = connections; this.defaultServer = ''; this.configurationMessage = '';
    try { this.defaultServer = defaultServerBaseUrl ? serverURL(defaultServerBaseUrl) : ''; } catch { this.configurationMessage = '로그인 서버 주소를 설정해 주세요.'; } this.connectivity = ''; this.lastState = ''; this.refreshing = null; this.cancelRevision = 0;
  }
  async status() {
    const storageAvailable = await this.connections.available();
    let config;
    try { config = storageAvailable ? await this.connections.read() : {}; }
    catch { return { status: 'unavailable', user: null, serverBaseUrl: this.defaultServer, storageAvailable, message: '저장된 계정을 읽지 못했습니다. 로컬 작업은 계속 사용할 수 있습니다.' }; }
    const session = config.session;
    let user = null;
    try { user = session?.user ? accountProfile(session.user) : null; } catch { this.connectivity = 'expired'; }
    const status = !storageAvailable ? 'unavailable' : !session ? 'guest' : this.connectivity === 'expired' ? 'expired' : this.connectivity === 'offline' ? 'offline' : session.expires_at <= Date.now() / 1000 || !user ? 'expired' : 'signed_in';
    return { status, user, serverBaseUrl: config.serverBaseUrl || this.defaultServer, storageAvailable,
      message: !storageAvailable ? '이 기기의 보안 저장소를 사용할 수 없어 로그인 정보를 저장할 수 없습니다.' : this.configurationMessage };
  }
  async publish() {
    const state = await this.status(), serialized = JSON.stringify(state);
    if (serialized !== this.lastState) { this.lastState = serialized; this.emit('changed', state); }
    return state;
  }
  async configure(value) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('ConText 서버 주소를 확인해 주세요.');
    const base = serverURL(value.trim());
    this.connections.cancelLogin();
    await this.connections.serialize(async () => {
      const config = await this.connections.read();
      if (config.serverBaseUrl !== base) { config.serverBaseUrl = base; config.session = null; config.auth = null; }
      await this.connections.persist(config);
    });
    this.configurationMessage = ''; this.connectivity = ''; return this.publish();
  }
  async login(base) {
    if (this.connections.pendingLogin) throw new Error('브라우저에서 진행 중인 로그인을 완료하거나 취소해 주세요.');
    const revision = this.cancelRevision;
    const state = await this.status();
    if (!state.storageAvailable) throw new Error(state.message);
    const selected = base ?? state.serverBaseUrl;
    const current = await this.connections.read();
    if (selected !== current.serverBaseUrl) await this.configure(selected);
    if (revision !== this.cancelRevision) throw new Error('로그인을 취소했습니다.');
    try { await this.connections.login(); this.connectivity = ''; return await this.publish(); }
    catch (error) {
      if (error.code === 'AUTH_LOGIN_CANCELLED') throw new Error('로그인을 취소했습니다.');
      if (error.code === 'AI_UNAVAILABLE' || error.code === 'AI_TIMEOUT') throw new Error('로그인 서버에 연결하지 못했습니다. 인터넷 연결과 ConText 서버 주소를 확인해 주세요.');
      throw error;
    }
  }
  cancel() { this.cancelRevision++; this.connections.cancelLogin(); }
  async logout() {
    // End only this device's Supabase session; web browser sessions stay signed in.
    this.cancel();
    let previous;
    await this.connections.serialize(async () => {
      const config = await this.connections.read(); previous = { session: config.session, auth: config.auth };
      config.session = null; config.auth = null; await this.connections.persist(config);
    });
    this.connectivity = ''; const result = await this.publish();
    if (previous.session && previous.auth) {
      void this.connections.fetcher(`${previous.auth.url}/auth/v1/logout?scope=local`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { apikey: previous.auth.key, Authorization: `Bearer ${previous.session.access_token}` } }).catch(() => {});
    }
    return result;
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshOnce() {
    let config;
    try {
      if (!await this.connections.available()) return this.publish();
      config = await this.connections.read();
      if (!config.session) { this.connectivity = ''; return this.publish(); }
      const identity = config.session.identity;
      const token = await this.connections.token(config);
      const user = accountProfile(await this.connections.fetcher(`${config.serverBaseUrl}/api/me`, { signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}` } }));
      await this.connections.serialize(async () => {
        const current = await this.connections.read();
        if (current.session?.identity !== identity || current.serverBaseUrl !== config.serverBaseUrl) return;
        if (current.session.user && current.session.user.id !== user.id) throw Object.assign(new Error('연결된 계정이 변경되었습니다. 다시 로그인해 주세요.'), { status: 401 });
        current.session = { ...current.session, user, email: user.email }; await this.connections.persist(current); this.connectivity = '';
      });
    } catch (error) {
      if (config?.session) {
        const current = await this.connections.read().catch(() => null);
        if (current?.session?.identity === config.session.identity) this.connectivity = [400, 401, 403].includes(error.status) ? 'expired' : 'offline';
      }
    }
    return this.publish();
  }
}
