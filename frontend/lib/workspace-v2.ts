"use client";
import { browserSupabase } from './supabase/client';
import { HttpWorkspaceRepository } from '@context/workspace-client/http';
import { subscribeWorkspaceChanges } from '@context/sync-client/events';

/** Authentication stays in the web shell; the common client never receives a token cache. */
export async function workspaceApi<T>(path: string, init?: RequestInit, expectedUserId?: string): Promise<T> {
  const { data, error } = await browserSupabase().auth.getSession();
  if (error || !data.session) throw new Error('다시 로그인해 주세요.');
  if (expectedUserId && data.session.user.id !== expectedUserId) throw new Error('로그인 계정이 변경되었습니다. 이 워크스페이스를 닫고 다시 열어 주세요. 이전 계정의 변경은 보존됩니다.');
  const origin = process.env.NEXT_PUBLIC_WORKSPACE_API_URL || 'http://localhost:8001';
  const response = await fetch(`${origin}/v2${path}`, { ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...init?.headers, Authorization: `Bearer ${data.session.access_token}` } }).catch(() => { throw new Error('워크스페이스 서버에 연결하지 못했습니다. 변경 내용과 브라우저 저장소는 보존됩니다.'); });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail || body?.error?.message;
    throw new Error(typeof detail === 'string' ? detail : response.status === 403 ? '이 작업을 수행할 권한이 없습니다.' : response.status === 404 ? '워크스페이스를 찾을 수 없습니다.' : '요청을 완료하지 못했습니다.');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
export function browserWorkspaceRepository(id: string) {
  let subject: string | undefined;
  return new HttpWorkspaceRepository(id, async <T,>(path: string, init?: RequestInit) => {
    const { data } = await browserSupabase().auth.getSession();
    if (!data.session) throw new Error('다시 로그인해 주세요.');
    subject ??= data.session.user.id;
    return workspaceApi<T>(path, init, subject);
  }, undefined, { subscribe: onHint => {
    const stop = subscribeWorkspaceChanges(async signal => {
      const { data } = await browserSupabase().auth.getSession();
      if (!data.session || subject !== data.session.user.id) throw Object.assign(new Error('로그인 계정이 변경되었습니다.'), { status: 401 });
      const origin = process.env.NEXT_PUBLIC_WORKSPACE_API_URL || 'http://localhost:8001';
      return fetch(`${origin}/v2/workspaces/${encodeURIComponent(id)}/events`, { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store', redirect: 'error', signal });
    }, () => onHint());
    const { data: listener } = browserSupabase().auth.onAuthStateChange((_event, session) => { if (!session || session.user.id !== subject) { stop(); onHint(); } });
    return () => { stop(); listener.subscription.unsubscribe(); };
  } });
}
