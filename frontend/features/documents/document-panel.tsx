"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Duplicate } from "./version-management";
import { fileStyle } from "./file-style";
import { statuses } from "@/lib/labels";
import { LuUpload, LuFileText } from "react-icons/lu";
import { api, type Workspace } from "@/lib/api";
import { completeUpload, downloadVersion, fileHash, sendFile, type UploadTicket, type WorkspaceDocument } from "./api";

const extensions = /\.(pdf|docx|hwpx|txt|md)$/i;
const available = new Set(["UPLOADED", "PROCESSING", "READY"]);
const pageSize = 100;

export function DocumentPanel({ workspace, onChange, initialFile, onPreview, onUploaded }: { workspace: Workspace; onChange?: () => void; initialFile?: File | null; onPreview?: (document: WorkspaceDocument) => void; onUploaded?: (document: WorkspaceDocument) => Promise<void> | void }) {
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [duplicateKey, setDuplicateKey] = useState("");
  const [confirmedDuplicate, setConfirmedDuplicate] = useState("");
  const canUpload = workspace.role !== "VIEWER";
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(initialFile || null);
  const [title, setTitle] = useState(initialFile?.name.replace(/\.[^.]+$/, "").slice(0, 200) || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const pendingPlacement = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    api<WorkspaceDocument[]>(`/workspaces/${workspace.id}/documents?limit=${pageSize}`)
      .then(items => { if (active) { setDocuments(items); setHasMore(items.length === pageSize); setLoaded(true); setListError(null); } })
      .catch((error: Error) => { if (active) setListError(error.message); });
    return () => { active = false; };
  }, [workspace.id, revision]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const items = await api<WorkspaceDocument[]>(`/workspaces/${workspace.id}/documents?limit=${pageSize}&offset=${documents.length}`);
      setDocuments(existing => [...existing, ...items.filter(item => !existing.some(doc => doc.id === item.id))]);
      setHasMore(items.length === pageSize);
      setListError(null);
    } catch (err) { setListError(err instanceof Error ? err.message : "문서를 불러오지 못했습니다."); }
    finally { setLoadingMore(false); }
  }

  function resetSelection() {
    setDuplicates([]); setDuplicateKey(""); setConfirmedDuplicate("");
    setFile(null); setTitle(""); requestId.current = null; setRetryVersion(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setActionError(null);
    if (!extensions.test(file.name) || file.size === 0) {
      setActionError("내용이 있는 PDF, DOCX, HWPX, TXT, Markdown 파일을 선택해 주세요."); return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setActionError("50 MB 이하의 파일을 선택해 주세요."); return;
    }
    setBusy(true); setProgress(0); setMessage("파일 확인 중…");
    try {
      const sha256 = await fileHash(file);
      let ticket: UploadTicket;
      if (retryVersion) {
        const version = documents.flatMap(doc => doc.versions).find(item => item.id === retryVersion);
        if (!version || version.sha256 !== sha256 || version.size !== file.size || version.original_filename !== file.name) {
          throw new Error("이름과 내용이 동일한 원본 파일을 선택해 주세요.");
        }
        ticket = await api<UploadTicket>(`/versions/${retryVersion}/upload-url`, { method: "POST" });
      } else {
        const fingerprint = `${sha256}:${file.size}`;
        const matches = await api<Duplicate[]>(`/workspaces/${workspace.id}/duplicates?sha256=${sha256}&size=${file.size}`);
        if (matches.length > 0) {
          setDuplicates(matches); setDuplicateKey(fingerprint);
          if (confirmedDuplicate !== fingerprint) { setMessage(""); return; }
        }
        requestId.current ??= crypto.randomUUID();
        ticket = await api<UploadTicket>(`/workspaces/${workspace.id}/documents/upload-url`, {
          method: "POST", body: JSON.stringify({ request_id: requestId.current, title: title.trim(), filename: file.name, size: file.size, sha256 }),
        });
      }
      setMessage("파일 업로드 중…");
      await sendFile(ticket, file, setProgress);
      setMessage("업로드 검증 중…");
      if (!retryVersion) pendingPlacement.current.add(ticket.version_id);
      const uploaded = await completeUpload(ticket.version_id);
      if (!retryVersion) await onUploaded?.(uploaded);
      pendingPlacement.current.delete(ticket.version_id);
      setMessage("문서를 올렸습니다. 본문 처리가 시작됩니다."); resetSelection();
    } catch (err) {
      setMessage(""); setActionError(err instanceof Error ? err.message : "문서를 올리지 못했습니다.");
    } finally {
      setBusy(false); setRevision(value => value + 1); onChange?.();
    }
  }

  async function versionAction(versionId: string, action: "download" | "complete") {
    setActiveVersion(versionId); setActionError(null);
    try {
      if (action === "download") await downloadVersion(versionId);
      else {
        const uploaded = await completeUpload(versionId);
        if (pendingPlacement.current.has(versionId)) {
          await onUploaded?.(uploaded); pendingPlacement.current.delete(versionId); resetSelection();
        }
        setRevision(value => value + 1); setMessage("업로드를 확인했습니다."); onChange?.();
      }
    } catch (err) { setActionError(err instanceof Error ? err.message : "요청을 완료하지 못했습니다."); }
    finally { setActiveVersion(null); }
  }

  return <section className="documents-panel" aria-labelledby="documents-heading">
    <h2 id="documents-heading"><LuFileText /> 문서 관리</h2>
    {canUpload && <form className="upload-panel" onSubmit={upload}>
      <h3><LuUpload /> {retryVersion ? "업로드 재시도" : "문서 업로드"}</h3>
      <p className="muted">PDF · DOCX · HWPX · TXT · Markdown / 최대 50 MB</p>
      <label htmlFor="document-file">{retryVersion ? "원본 파일 선택" : "파일"}</label>
      <input ref={fileInput} id="document-file" type="file" accept=".pdf,.docx,.hwpx,.txt,.md" disabled={busy} onChange={event => {
        const selected = event.target.files?.[0] || null;
        setFile(selected); requestId.current = null; setDuplicates([]); setConfirmedDuplicate(""); setDuplicateKey("");
        if (!retryVersion) setTitle(selected?.name.replace(/\.[^.]+$/, "").slice(0, 200) || "");
      }} />
      {!retryVersion && <><label htmlFor="document-title">문서 제목</label>
        <input id="document-title" value={title} maxLength={200} required disabled={busy} onChange={event => { setTitle(event.target.value); requestId.current = null; }} /></>}
      {file && <p className="selected-file">{file.name}</p>}
      {!!duplicates.length && <div className="duplicate-notice" role="status"><strong>동일한 파일이 이미 있습니다.</strong><ul>{duplicates.map(item => <li key={item.version.id}>{item.document_title} · 수정 이력 {item.version.version_number}{onPreview && <button className="text-button" type="button" disabled={busy} onClick={async () => { try { onPreview(await api<WorkspaceDocument>(`/documents/${item.document_id}`)); } catch (err) { setActionError(err instanceof Error ? err.message : "문서를 열지 못했습니다."); } }}>기존 문서 보기</button>}</li>)}</ul><label className="switch-label"><input type="checkbox" checked={confirmedDuplicate === duplicateKey} onChange={event => setConfirmedDuplicate(event.target.checked ? duplicateKey : "")} />중복을 확인했으며 별도 문서로 등록합니다.</label></div>}
      <div className="document-actions">
        <button className="primary" disabled={busy || !file || (!retryVersion && !title.trim())}>{busy ? "업로드 중…" : retryVersion ? "업로드 재시도" : "문서 올리기"}</button>
        {retryVersion && <button type="button" className="secondary" disabled={busy} onClick={resetSelection}>재시도 취소</button>}
      </div>
      {busy && <progress aria-label="업로드 진행률" value={progress} max={100} />}
    </form>}
    {message && <p role="status">{message}</p>}
    {actionError && <p role="alert" className="error">{actionError}</p>}
    {listError && <p role="alert" className="error">{listError} <button className="secondary" onClick={() => setRevision(value => value + 1)}>문서 다시 불러오기</button></p>}
    {!loaded && !listError && <p role="status">문서를 불러오는 중…</p>}
    {loaded && documents.length === 0 && <div className="empty"><h3>아직 문서가 없습니다</h3><p className="muted">{canUpload ? "첫 문서를 올려 팀의 지식을 연결해 보세요." : "팀에서 올린 문서가 여기에 표시됩니다."}</p></div>}
    <ul className="document-list">{documents.map(doc => {
      const version = doc.versions.find(item => item.id === doc.current_version_id) || doc.versions[doc.versions.length - 1];
      if (!version) return null;
      const { kind, Icon, name } = fileStyle(version.original_filename);
      return <li className={`document-row file-theme-${kind}`} key={doc.id}>
        <div><span className="list-file-kind"><Icon /> {name}</span><h3>{onPreview ? <button className="document-title-button" aria-label={`${doc.title} 미리보기`} onClick={() => onPreview(doc)}>{doc.title}</button> : doc.title}</h3><p className="muted">{version.original_filename} · {Math.max(1, Math.ceil(version.size / 1024))} KB · 이력 {version.version_number}</p>
          <span className="badge">{statuses[version.status]}</span></div>
        <div className="document-actions">
          {(version.uploaded_at || available.has(version.status)) && <button className="secondary" disabled={activeVersion !== null || busy} onClick={() => versionAction(version.id, "download")}>다운로드</button>}
          {canUpload && version.status === "UPLOADING" && <>
            <button className="secondary" disabled={activeVersion !== null || busy} onClick={() => versionAction(version.id, "complete")}>업로드 확인</button>
            <button className="secondary" disabled={activeVersion !== null || busy} onClick={() => { resetSelection(); setRetryVersion(version.id); setMessage(`${version.original_filename} 파일을 다시 선택해 주세요.`); fileInput.current?.focus(); }}>파일 다시 선택</button>
          </>}
        </div>
      </li>;
    })}</ul>
    {hasMore && <button className="secondary" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "불러오는 중…" : "더 보기"}</button>}
  </section>;
}
