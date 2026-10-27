import type { ChatRepository } from '@context/workspace-ui/shared/core/chat';

export function localChatRepository(workspaceId: string): ChatRepository {
  const api = window.contextDesktop;
  return {
    sessions: offset => api.chatSessions(workspaceId, offset),
    indexStatus: () => api.chatIndexStatus(workspaceId),
    messages: session => api.chatMessages(workspaceId, session),
    search: input => api.chatSearch(workspaceId, input),
    createSession: input => api.createChatSession(workspaceId, input),
    ask: (session, input) => api.askChat(workspaceId, session, input),
    retry: (session, message) => api.retryChat(workspaceId, session, message),
    reindex: () => api.indexDocuments(workspaceId),
  };
}
