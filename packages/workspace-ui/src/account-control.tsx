"use client";
import { useEffect, useRef, useState } from 'react';
import { FcGoogle } from 'react-icons/fc';
import { LuCheck, LuChevronRight, LuCloudOff, LuLoaderCircle, LuLogIn, LuLogOut, LuSettings2, LuUserRound, LuX } from 'react-icons/lu';
import type { AccountState } from '../shared/core/account';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
import './account-control.css';

export interface AccountRepository {
  accountStatus(): Promise<AccountState>; accountRefresh(): Promise<AccountState>;
  accountLogin(server?: string): Promise<AccountState>; accountLogout(): Promise<AccountState>;
  accountCancelLogin(): Promise<void>; accountConfigure?: (server: string) => Promise<AccountState>;
  onAccountChanged(callback: (state: AccountState) => void): () => void;
}
const statusLabel = { guest: '로컬 모드', signed_in: '로그인됨', offline: '오프라인', expired: '다시 로그인', unavailable: '로컬 모드' };

export function AccountControl({ repository: api }: { repository: AccountRepository }) {
  const [state, setState] = useState<AccountState>();
  const [open, setOpen] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.accountStatus().then(value => { if (active) setState(value); }).catch(() => { if (active) setError('계정 정보를 불러오지 못했습니다.'); });
    const unsubscribe = api.onAccountChanged(value => { if (active) { setState(value); setError(''); } });
    return () => { active = false; unsubscribe(); };
  }, [api]);
  return <div className="desktop-account-control">
    <button className="desktop-account-button" aria-label={state?.user ? '계정 관리' : '로그인'} title={state?.user?.email || '웹과 같은 계정으로 로그인'} onClick={() => setOpen(true)}>
      <span className="account-avatar">{state?.user ? state.user.display_name?.slice(0, 1) || state.user.email.slice(0, 1) : <LuUserRound />}</span>
      <span className="account-label"><strong>{state?.user?.display_name || state?.user?.email || '로그인'}</strong><small>{state ? statusLabel[state.status] : '로컬 모드'}</small></span><LuChevronRight />
    </button>
    {open && <AccountDialog api={api} state={state} initialError={error} update={setState} close={() => setOpen(false)} />}
  </div>;
}

function AccountDialog({ api, state, update, close, initialError }: { api: AccountRepository; state?: AccountState; update: (state: AccountState) => void; close: () => void; initialError: string }) {
  const [server, setServer] = useState<string>(), [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false), [loggingIn, setLoggingIn] = useState(false), [error, setError] = useState(initialError);
  const mounted = useRef(true), operation = useRef(0);
  const cancelRequested = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current++; };
  }, []);
  async function run(action: () => Promise<AccountState>) {
    if (busy) return;
    const version = ++operation.current; setBusy(true); setError('');
    try { const result = await action(); if (mounted.current && version === operation.current) update(result); }
    catch (reason) { if (mounted.current && version === operation.current && !cancelRequested.current) setError((reason as Error).message); }
    finally { if (mounted.current && version === operation.current) { setBusy(false); setLoggingIn(false); } }
  }
  async function dismiss() {
    cancelRequested.current = true;
    if (loggingIn) { try { await api.accountCancelLogin(); } catch { cancelRequested.current = false; setError('로그인 취소를 완료하지 못했습니다. 다시 시도해 주세요.'); return; } }
    close();
  }
  const connected = !!state?.user;
  return <DocumentPreviewFrame className="account-dialog" labelledBy="desktop-account-title" onClose={() => { if (!busy || loggingIn) void dismiss(); }}>
    <header className="account-heading"><h2 id="desktop-account-title">{connected ? 'ConText 계정' : '로그인'}</h2><button className="icon-button" aria-label="계정 창 닫기" disabled={busy && !loggingIn} onClick={() => void dismiss()}><LuX /></button></header>
    <div className="account-body">
      {connected ? <div className="account-profile"><span className="account-avatar">{state.user!.display_name?.slice(0, 1) || state.user!.email.slice(0, 1)}</span><strong>{state.user!.display_name || state.user!.email}</strong><span>{state.user!.email}</span><small className={`account-status account-status-${state.status}`}>{state.status === 'signed_in' ? <LuCheck /> : <LuCloudOff />}{statusLabel[state.status]}</small></div> : <p>같은 Google 계정으로 웹과 데스크톱에서 이어서 작업하세요.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {state?.message && <p role="status">{state.message}</p>}
      {loggingIn ? <div className="account-waiting" role="status"><LuLoaderCircle className="spin" /><span>브라우저에서 로그인을 완료해 주세요.</span></div> : state?.status === 'signed_in' ? <button disabled={busy} onClick={() => void run(api.accountRefresh)}><LuCheck />계정 확인</button> : <button className="primary account-google" disabled={busy || !state?.storageAvailable} onClick={() => { cancelRequested.current = false; setLoggingIn(true); void run(() => api.accountLogin(server ?? state?.serverBaseUrl)); }}><FcGoogle />Google로 계속하기</button>}
      {connected && !loggingIn && <button className="account-logout" disabled={busy} onClick={() => void run(api.accountLogout)}><LuLogOut />로그아웃</button>}
      {api.accountConfigure && <div className="account-server-settings"><button className="account-settings-toggle" aria-label="로그인 서버 설정" aria-expanded={settings} disabled={busy} onClick={() => setSettings(value => !value)}><LuSettings2 /><span>서버 설정</span></button>{settings && <form onSubmit={event => { event.preventDefault(); void run(() => api.accountConfigure!(server ?? state?.serverBaseUrl ?? '')); }}><label>ConText 서버 주소<input type="url" aria-label="로그인 서버 주소" required value={server ?? state?.serverBaseUrl ?? ''} placeholder="https://api.example.com" disabled={busy} onChange={event => setServer(event.target.value)} /></label><button type="submit" disabled={busy}>주소 저장</button></form>}</div>}
    </div>
    <footer className="account-footer"><small>같은 계정의 웹과 데스크톱에서 워크스페이스를 연결합니다.</small><button disabled={busy && !loggingIn} onClick={() => void dismiss()}>{loggingIn ? '취소하고 로컬로 계속' : connected ? '완료' : '로그인 없이 계속'}{!connected && <LuLogIn />}</button></footer>
  </DocumentPreviewFrame>;
}
