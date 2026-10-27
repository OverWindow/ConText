"use client";
import { api } from '@/lib/api';
import type { ChatRepository } from '../../shared/core/chat';

export function webChatRepository(workspaceId: string): ChatRepository {
  const base = `/workspaces/${workspaceId}`;
  return {
    sessions: offset => api(`${base}/chat/sessions?offset=${offset}`),
    indexStatus: () => api(`${base}/rag/status`),
    messages: id => api(`${base}/chat/sessions/${id}/messages`),
    search: input => api(`${base}/search`, { method: 'POST', body: JSON.stringify(input) }),
    createSession: ({ requestId, title }) => api(`${base}/chat/sessions`, { method: 'POST', body: JSON.stringify({ request_id: requestId, title }) }),
    ask: (id, { requestId, ...input }) => api(`${base}/chat/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ ...input, request_id: requestId }) }),
    retry: (sessionId, messageId) => api(`${base}/chat/sessions/${sessionId}/messages/${messageId}/retry`, { method: 'POST' }),
    reindex: async () => { await api(`${base}/rag/reindex`, { method: 'POST' }); },
  };
}
