"use client";
import { api } from "@/lib/api";
import { browserSupabase } from "@/lib/supabase/client";
import type { DraftRepository, WritingDraft } from "./types";

export function webDraftRepository(workspaceId: string): DraftRepository {
  const base = `/workspaces/${workspaceId}/writing`;
  return {
    list: () => api(base),
    get: id => api(`${base}/${id}`),
    create: requestId => api(`${base}/blank`, { method: "POST", body: JSON.stringify({ request_id: requestId }) }),
    save: (id, revision, content) => api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify({ revision, content }) }),
    generate: ({ draftId, revision, prompt, requestId }) => api<WritingDraft>(draftId ? `${base}/${draftId}/propose` : base, {
      method: "POST", body: JSON.stringify({ prompt, request_id: requestId, ...(draftId ? { revision } : {}) }),
    }),
    review: (id, revision, action) => api(`${base}/${id}/${action}`, { method: "POST", body: JSON.stringify({ revision }) }),
    remove: (id, revision) => api(`${base}/${id}?revision=${revision}`, { method: "DELETE" }),
    export: async (id, revision, format) => {
      const { data } = await browserSupabase().auth.getSession();
      if (!data.session) throw new Error("다시 로그인해 주세요.");
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api${base}/${id}/export/${format}?revision=${revision}`, {
        headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: "no-store",
      });
      if (response.status === 409) throw new Error("다른 곳에서 문서가 변경됐습니다. 저장된 문서를 다시 열어 주세요.");
      if (!response.ok) throw new Error("파일을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      const draft = await api<WritingDraft>(`${base}/${id}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `${draft.title.replace(/[\\/:*?"<>|]/g, "_")}.${format}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };
}
