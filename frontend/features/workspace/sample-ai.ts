"use client";
import { browserSupabase } from '@/lib/supabase/client';
import type { AIConnectionState } from '@context/workspace-ui/shared/core/ai';
import type { SampleAIAdapter } from '@context/workspace-ui/sample-ai';

// Keep anonymous sample work visible when authentication is missing or expires.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let token: string | undefined;
  try { token = (await browserSupabase().auth.getSession()).data.session?.access_token; } catch { /* Public previews can run without an auth configuration. */ }
  if (!token) throw new Error('AI를 사용하려면 로그인한 뒤 AI 연결 설정에서 모델을 선택해 주세요. 작성한 샘플 문서는 이 기기에 보관됩니다.');
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/ai${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (response.status === 401) throw new Error('로그인이 만료되었습니다. 다시 로그인한 뒤 AI를 사용해 주세요.');
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.detail === 'string' ? error.detail : 'AI 요청을 완료하지 못했습니다. 연결 설정을 확인해 주세요.');
  }
  return response.json();
}
export const webSampleAI: Omit<SampleAIAdapter, 'signIn'> = {
  connection: {
    get: () => request<AIConnectionState>('/connection'),
    save: value => request('/connection', { method: 'PUT', body: JSON.stringify(value) }),
    removePersonal: () => request('/connection', { method: 'DELETE' }),
    models: () => request('/models'),
  },
  generate: input => request('/context', { method: 'POST', body: JSON.stringify({ ...input, sources: input.sources.map(({ id, kind, document_title, text, document_id, version_id, version_number, is_current, locations }) => ({ id, kind, document_title, text, document_id, version_id, version_number, is_current, locations })) }) }),
};
