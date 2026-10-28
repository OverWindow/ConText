"use client";
import { useEffect, useRef, useState } from 'react';
import type { AIConnectionRepository, AIConnectionState } from '../core/ai';
import './ai-settings.css';

export function AISettings({ repository, onClose, onSignIn }: { repository: AIConnectionRepository; onClose: () => void; onSignIn?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<AIConnectionState>();
  const [key, setKey] = useState('');
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  useEffect(() => {
    let active = true; dialog.current?.showModal();
    repository.get().then(value => { if (active) setState(value); }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [repository]);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    if (!state) return;
    const value = await repository.save({ mode: state.mode, model: state.model, ...(key ? { api_key: key } : {}), ...(state.serverBaseUrl !== undefined ? { serverBaseUrl: state.serverBaseUrl } : {}) });
    setState(value); setKey(''); setNotice('AI 연결 설정을 저장했습니다.');
  }
  return <dialog ref={dialog} className="ai-settings" aria-label="AI 연결 설정" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>AI 연결 설정</h2><button aria-label="AI 설정 닫기" disabled={busy} onClick={onClose}>닫기</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    {!state && error && onSignIn && <button onClick={onSignIn}>로그인하고 AI 연결하기</button>}
    {notice && <p role="status">{notice}</p>}
    {state ? <>
      <label>연결 방식<select aria-label="AI 연결 방식" value={state.mode} disabled={busy} onChange={event => { setState({ ...state, mode: event.target.value as AIConnectionState['mode'], model: '' }); setModels([]); }}><option value="managed">기본 ChatKHU</option><option value="personal">내 ChatKHU</option></select></label>
      {state.mode === 'personal' ? <>
        <p>ChatKHU에서 발급한 API 키를 연결합니다. 사용 크레딧은 해당 계정에서 차감됩니다.</p>
        <label>{state.has_personal_key ? 'API 키 교체' : 'ChatKHU API 키'}<input aria-label="ChatKHU API 키" type="password" autoComplete="off" value={key} disabled={busy || !state.personal_key_storage_available} onChange={event => setKey(event.target.value)} placeholder={state.has_personal_key ? '새 키를 입력하면 교체됩니다' : 'API Gateway에서 발급한 키'} /></label>
        {!state.personal_key_storage_available && <p role="status">개인 키를 보관할 보안 저장소 설정이 필요합니다.</p>}
        {state.has_personal_key && <button disabled={busy} onClick={() => void run(async () => { setState(await repository.removePersonal()); setKey(''); setModels([]); setNotice('개인 키 연결을 삭제했습니다.'); })}>개인 키 삭제</button>}
      </> : <>
        <p>ConText 서버를 통해 ChatKHU를 사용합니다.</p>
        {state.serverBaseUrl !== undefined && <label>ConText 서버 주소<input aria-label="ConText 서버 주소" type="url" value={state.serverBaseUrl} disabled={busy} placeholder="https://서버주소" onChange={event => setState({ ...state, serverBaseUrl: event.target.value })} /></label>}
        {repository.login && <div className="ai-account"><p>{state.signed_in ? `${state.email || 'ConText'} 계정 연결됨` : '기본 AI를 사용하려면 계정을 연결해 주세요.'}</p><button disabled={busy} onClick={() => void run(async () => { await save(); setLoggingIn(true); try { setState(await repository.login!()); } finally { setLoggingIn(false); } })}>Google로 계정 연결</button>{loggingIn && repository.cancelLogin && <button onClick={() => void repository.cancelLogin!().catch(reason => setError(reason.message))}>계정 연결 취소</button>}{state.signed_in && <button disabled={busy} onClick={() => void run(async () => setState(await repository.logout!()))}>계정 연결 해제</button>}</div>}
      </>}
      <div className="ai-model-actions"><button disabled={busy} onClick={() => void run(async () => { await save(); setModels(await repository.models()); setNotice('사용 가능한 모델을 불러왔습니다. 모델을 선택하고 저장해 주세요.'); })}>연결 확인 · 모델 불러오기</button></div>
      <label>사용할 모델<select aria-label="AI 모델" disabled={busy || !models.length} value={state.model} onChange={event => setState({ ...state, model: event.target.value })}><option value={state.model}>{state.model || '모델을 불러와 선택하세요'}</option>{models.filter(model => model.id !== state.model).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <p className="ai-data-note">AI 요청에는 관련 자료의 발췌문과 작성 중인 내용이 전송됩니다. 개인 연결 실패 시 다른 계정으로 자동 전환하지 않습니다.</p>
      <footer><button disabled={busy} onClick={() => void run(save)}>{busy ? '처리 중…' : '설정 저장'}</button></footer>
    </> : !error && <p role="status">연결 설정을 확인하는 중…</p>}
  </dialog>;
}
