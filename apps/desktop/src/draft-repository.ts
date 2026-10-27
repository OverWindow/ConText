import type { DraftRepository } from '@context/workspace-ui/shared/core/writing';
import type { AIConnectionRepository } from '@context/workspace-ui/shared/core/ai';

export const desktopAIRepository: AIConnectionRepository = {
  get: () => window.contextDesktop.aiConnection(),
  save: value => window.contextDesktop.saveAIConnection(value),
  removePersonal: () => window.contextDesktop.removePersonalAI(),
  models: () => window.contextDesktop.aiModels(),
  login: () => window.contextDesktop.aiLogin(),
  logout: () => window.contextDesktop.aiLogout(),
  cancelLogin: () => window.contextDesktop.aiCancelLogin(),
};

export function localDraftRepository(workspaceId: string): DraftRepository {
  const api = window.contextDesktop;
  return {
    list: () => api.listDrafts(workspaceId),
    get: id => api.getDraft(workspaceId, id),
    create: requestId => api.createDraft(workspaceId, requestId),
    save: (id, revision, content) => api.saveDraft(workspaceId, id, revision, content),
    generate: input => api.generateDraft(workspaceId, input),
    review: (id, revision, action) => api.reviewDraft(workspaceId, id, revision, action),
    remove: (id, revision) => api.deleteDraft(workspaceId, id, revision),
    export: (id, revision, format) => api.exportDraft(workspaceId, id, revision, format),
  };
}
