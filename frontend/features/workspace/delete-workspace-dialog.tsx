"use client";
import { useState, type FormEvent } from "react";
import { LuTrash2, LuX } from "react-icons/lu";
import { DocumentPreviewFrame } from '@context/workspace-ui/shared/ui/document-preview-frame';
import { type Workspace } from "@/lib/api";
import { browserWorkspaceRepository } from '@/lib/workspace-v2';

export function DeleteWorkspaceDialog({ workspace, onClose, onDeleted }: {
  workspace: Workspace; onClose: () => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (busy || name !== workspace.name) return;
    setBusy(true); setError("");
    const repository = browserWorkspaceRepository(workspace.id);
    try { await repository.load(); await repository.deleteWorkspace(); onDeleted(); }
    catch (reason) { setError((reason as Error).message); setBusy(false); }
    finally { repository.dispose(); }
  }
  return <DocumentPreviewFrame className="new-text-file workspace-delete-dialog" labelledBy="delete-workspace-title" onClose={() => { if (!busy) onClose(); }}>
    <div className="panel-heading"><h2 id="delete-workspace-title">워크스페이스 삭제</h2><button className="icon-button" aria-label="삭제 창 닫기" disabled={busy} onClick={onClose}><LuX /></button></div>
    <form className="panel-scroll workspace-delete-form" onSubmit={remove}>
      <p><strong>{workspace.name}</strong>을 삭제하면 모든 팀원이 접근할 수 없고 목록에서 사라집니다.</p>
      {workspace.sync_mode === "desktop" && <p>진행 중인 전송과 이후 동기화도 차단합니다. 데스크톱 원본 폴더와 로컬 작업 내용은 유지됩니다. 같은 연결로 다시 동기화할 수 없습니다.</p>}
      <p className="muted">앱에서 삭제를 되돌릴 수 없습니다. 서버 자료는 삭제 상태로 보관되며 즉시 영구 파기되지는 않습니다.</p>
      <label htmlFor="delete-workspace-name">확인을 위해 워크스페이스 이름을 입력하세요</label>
      <input id="delete-workspace-name" value={name} onChange={event => setName(event.target.value)} autoComplete="off" disabled={busy} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="document-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>취소</button><button className="danger" disabled={busy || name !== workspace.name}><LuTrash2 />{busy ? "삭제 중…" : "워크스페이스 삭제"}</button></div>
    </form>
  </DocumentPreviewFrame>;
}
