"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LuGitCompareArrows, LuLink, LuUpload } from "react-icons/lu";
import { api } from "@/lib/api";
import { message, statuses } from "@/lib/labels";
import { completeUpload, downloadVersion, fileHash, sendFile, type DocumentVersion, type UploadTicket, type WorkspaceDocument } from "./api";
import { ChangeIntelligence } from "./version-intelligence";
import { DocumentReader } from "./document-reader";
import { VersionTimelineView } from "../../shared/ui/version-timeline";
export type Duplicate = { document_id: string; document_title: string; version: DocumentVersion };
export const isVerified = (v: DocumentVersion) => !!v.uploaded_at || ["UPLOADED", "PROCESSING", "READY"].includes(v.status);
export const registeredAt = (v: DocumentVersion) => v.created_at ? new Date(v.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "등록 시각 정보 없음";

export function VersionTimeline({ document, editable, selectedId, onSelect, onChange }: { document: WorkspaceDocument; editable: boolean; selectedId: string; onSelect: (id: string) => void; onChange: () => void }) {
  return <VersionTimelineView versions={document.versions} currentId={document.current_version_id} selectedId={selectedId} editable={editable} onSelect={onSelect} onAction={async (version, kind) => {
    if (kind === "current") await api(`/documents/${document.id}/current-version`, { method: "PATCH", body: JSON.stringify({ version_id: version.id }) });
    else if (kind === "complete") await completeUpload(version.id);
    else await downloadVersion(version.id);
    onChange();
  }} />;
}

export function VersionRegistration({ document, onChange }: { document: WorkspaceDocument; onChange: () => void }) {
  const [mode, setMode] = useState<"upload" | "link">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [retryId, setRetryId] = useState("");
  const [sourceDocId, setSourceDocId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sources, setSources] = useState<WorkspaceDocument[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceRetry, setSourceRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [progress, setProgress] = useState(0);
  const requestId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = document.versions.filter(v => v.status === "UPLOADING");
  useEffect(() => {
    if (mode !== "link") return;
    let active = true;
    api<WorkspaceDocument[]>(`/workspaces/${document.workspace_id}/documents?limit=100&offset=${offset}`).then(items => {
      if (!active) return;
      setSources(current => offset === 0 ? items : [...current, ...items.filter(item => !current.some(existing => existing.id === item.id))]); setHasMore(items.length === 100); setSourceError("");
    }).catch(err => { if (active) setSourceError(message(err)); });
    return () => { active = false; };
  }, [document.workspace_id, mode, offset, sourceRetry]);
  function resetRequest() { requestId.current = null; setError(""); setSuccess(""); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setSuccess(""); setProgress(0);
    try {
      requestId.current ??= crypto.randomUUID();
      if (mode === "link") {
        await api(`/documents/${document.id}/versions/link`, { method: "POST", body: JSON.stringify({ request_id: requestId.current, source_version_id: sourceId, change_note: note.trim() || null }) });
        setSuccess("선택한 원본을 새 수정 이력으로 연결했습니다. 현재 수정 이력은 수정 이력에서 지정해 주세요.");
      } else {
        if (!file || !/\.(pdf|docx|hwpx|txt|md)$/i.test(file.name) || file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error("내용이 있는 지원 파일을 선택해 주세요. 최대 크기는 50 MB입니다.");
        const sha256 = await fileHash(file);
        let ticket: UploadTicket;
        if (retryId) {
          const original = pending.find(v => v.id === retryId);
          if (!original || original.sha256 !== sha256 || original.size !== file.size || original.original_filename !== file.name) throw new Error("재시도할 수정 이력과 이름·내용이 같은 원본 파일을 선택해 주세요.");
          ticket = await api<UploadTicket>(`/versions/${retryId}/upload-url`, { method: "POST" });
        } else ticket = await api<UploadTicket>(`/documents/${document.id}/versions/upload-url`, { method: "POST", body: JSON.stringify({ request_id: requestId.current, filename: file.name, size: file.size, sha256, change_note: note.trim() || null }) });
        await sendFile(ticket, file, setProgress);
        await completeUpload(ticket.version_id);
        setSuccess("새 수정 이력을 등록했습니다. 현재 수정 이력은 수정 이력에서 지정해 주세요.");
        setFile(null); setRetryId(""); if (fileInput.current) fileInput.current.value = "";
      }
      requestId.current = null; setNote(""); onChange();
    } catch (err) { setError(message(err)); onChange(); } finally { setBusy(false); }
  }
  return <section className="version-registration" aria-label="새 수정 이력 등록"><h3>새 수정 이력 등록</h3><div className="version-mode"><button className={mode === "upload" ? "primary" : "secondary"} disabled={busy} onClick={() => { setMode("upload"); resetRequest(); }}><LuUpload /> 파일 업로드</button><button className={mode === "link" ? "primary" : "secondary"} disabled={busy} onClick={() => { setMode("link"); setRetryId(""); resetRequest(); }}><LuLink /> 기존 수정 이력 연결</button></div>
    <form onSubmit={submit}>{mode === "upload" ? <>
      {!!pending.length && <><label htmlFor="retry-version">등록 방식</label><select id="retry-version" value={retryId} disabled={busy} onChange={e => { setRetryId(e.target.value); resetRequest(); }}><option value="">새 수정 이력 업로드</option>{pending.map(v => <option value={v.id} key={v.id}>수정 이력 {v.version_number} 재시도 — {v.original_filename}</option>)}</select></>}
      <label htmlFor="new-version-file">수정 이력 파일</label><input id="new-version-file" ref={fileInput} type="file" accept=".pdf,.docx,.hwpx,.txt,.md" required disabled={busy} onChange={e => { setFile(e.target.files?.[0] || null); resetRequest(); }} />
      <p className="muted">파일 형식이 달라도 같은 문서의 수정 이력으로 등록할 수 있습니다.</p>
    </> : <><p className="muted">같은 워크스페이스의 검증된 원본을 연결합니다. 원래 문서는 유지됩니다.</p>
      {sourceError && <p role="alert" className="error">{sourceError} <button type="button" className="text-button" onClick={() => setSourceRetry(v => v + 1)}>다시 불러오기</button></p>}
      <label htmlFor="source-document">원본 문서</label><select id="source-document" required value={sourceDocId} disabled={busy} onChange={e => { setSourceDocId(e.target.value); setSourceId(""); resetRequest(); }}><option value="">연결할 문서 선택</option>{sources.filter(doc => doc.id !== document.id && doc.versions.some(isVerified)).map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select>
      {hasMore && <button type="button" className="text-button" onClick={() => setOffset(v => v + 100)}>원본 문서 더 불러오기</button>}
      <label htmlFor="source-version">원본 수정 이력</label><select id="source-version" required value={sourceId} disabled={busy || !sourceDocId} onChange={e => { setSourceId(e.target.value); resetRequest(); }}><option value="">수정 이력 선택</option>{sources.find(doc => doc.id === sourceDocId)?.versions.filter(isVerified).map(v => <option value={v.id} key={v.id}>수정 이력 {v.version_number} · {v.original_filename}</option>)}</select>
    </>}
      {!retryId && <><label htmlFor="version-note">등록 메모 (선택)</label><input id="version-note" maxLength={500} disabled={busy} value={note} placeholder="예: 가격 정책 수정본" onChange={e => { setNote(e.target.value); resetRequest(); }} /></>}
      <button className="primary wide" disabled={busy || (mode === "upload" ? !file : !sourceId)}>{busy ? "등록 중…" : mode === "upload" ? "새 수정 이력 올리기" : "이 문서의 수정 이력으로 연결"}</button>
      {busy && mode === "upload" && <progress aria-label="수정 이력 업로드 진행률" value={progress} max={100} />}
    </form>{error && <p role="alert" className="error">{error}</p>}{success && <p role="status" className="success-message">{success}</p>}
  </section>;
}

type Comparison = { left: DocumentVersion; right: DocumentVersion; identical: boolean };
export function VersionComparison({ document, editable, onChange }: { document: WorkspaceDocument; editable: boolean; onChange: () => void }) {
  const [left, setLeft] = useState(document.versions.at(-2)?.id || "");
  const [right, setRight] = useState(document.versions.at(-1)?.id || "");
  const [result, setResult] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function compare(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setResult(null);
    try { setResult(await api<Comparison>(`/documents/${document.id}/compare?left=${left}&right=${right}`)); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <section className="version-comparison" aria-label="수정 이력 비교"><form className="compare-form" onSubmit={compare}><div><label htmlFor="compare-left">이전 수정 이력</label><select id="compare-left" disabled={busy} value={left} onChange={e => { setLeft(e.target.value); setResult(null); }}><option value="">수정 이력 선택</option>{document.versions.map(v => <option key={v.id} value={v.id}>수정 이력 {v.version_number} · {v.original_filename}</option>)}</select></div><div><label htmlFor="compare-right">비교할 수정 이력</label><select id="compare-right" disabled={busy} value={right} onChange={e => { setRight(e.target.value); setResult(null); }}><option value="">수정 이력 선택</option>{document.versions.map(v => <option key={v.id} value={v.id}>수정 이력 {v.version_number} · {v.original_filename}</option>)}</select></div><button className="primary" disabled={busy || !left || !right || left === right}><LuGitCompareArrows /> 비교하기</button></form>
    <p className="muted">추가·삭제·수정된 문단과 AI 변경 요약을 확인하고 원문을 비교합니다.</p>{error && <p role="alert" className="error">{error}</p>}{result && <><p className="comparison-result" role="status">{result.identical ? "SHA-256과 크기가 같은 동일 파일입니다." : !isVerified(result.left) || !isVerified(result.right) ? "업로드 검증 전인 수정 이력이 있습니다. 파일 동일 여부는 아직 확정되지 않았습니다." : "두 수정 이력의 파일 내용이 다릅니다."}</p>{result.left.status === "READY" && result.right.status === "READY" && <ChangeIntelligence key={`${result.left.id}:${result.right.id}`} documentId={document.id} left={result.left.id} right={result.right.id} editable={editable} />}<div className="compare-columns">{[result.left, result.right].map(v => <article key={v.id} className="compare-column" aria-label={`수정 이력 ${v.version_number} 비교 본문`}><h3>수정 이력 {v.version_number}</h3><p>{v.original_filename}</p><p className="muted">{v.author_name || "팀원"} · {registeredAt(v)}</p><p className="muted">{v.size.toLocaleString("ko-KR")} 바이트 · {statuses[v.status]}</p><code className="checksum">SHA-256 {v.sha256}</code>{isVerified(v) ? <DocumentReader version={v} editable={editable} onChange={onChange} /> : <p className="notice">업로드 검증을 먼저 완료해 주세요.</p>}</article>)}</div></>}
  </section>;
}
