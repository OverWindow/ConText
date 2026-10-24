"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LuUserPlus, LuX } from "react-icons/lu";
import { api } from "@/lib/api";
import { message, roles } from "@/lib/labels";
export type Member = { id: string; display_name: string; role: keyof typeof roles };
export function AddMemberDialog({ workspaceId, onClose, onAdded }: { workspaceId: string; onClose: () => void; onAdded: (member: Member) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const member = await api<Member>(`/workspaces/${workspaceId}/members`, { method: "POST", body: JSON.stringify({ email: email.trim(), role }) });
      onAdded(member); setSuccess(`${member.display_name}님이 팀원 목록에 반영되었습니다. (${roles[member.role]})`); setEmail("");
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="document-dialog member-dialog" aria-labelledby="add-member-title" onCancel={onClose} onClose={onClose}>
    <div className="panel-heading"><h2 id="add-member-title"><LuUserPlus /> 팀원 추가</h2><button className="icon-button" aria-label="팀원 추가 닫기" onClick={onClose}><LuX /></button></div>
    <form className="panel-scroll" onSubmit={submit}><p className="muted">추가할 팀원이 먼저 이 서비스에 Google로 로그인해야 합니다. 입력한 이메일의 계정에 이 워크스페이스 접근 권한을 부여합니다.</p>
      <label htmlFor="member-email">팀원 이메일</label><input id="member-email" type="email" maxLength={320} required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" disabled={busy} />
      <label htmlFor="member-role">팀원 권한</label><select id="member-role" value={role} onChange={e => setRole(e.target.value)} disabled={busy}><option value="VIEWER">열람자 — 문서 읽기 및 다운로드</option><option value="EDITOR">편집자 — 문서 업로드 및 연결 편집</option></select>
      <p className="muted">이미 참여한 팀원의 권한은 유지됩니다.</p>
      {error && <p role="alert" className="error">{error}</p>}{success && <p role="status" className="success-message">{success}</p>}
      <button className="primary wide" disabled={busy || !email.trim()}><LuUserPlus />{busy ? "추가 중…" : "팀원 추가하기"}</button>
    </form>
  </dialog>;
}
