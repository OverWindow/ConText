"use client";
import { useEffect, useRef, useState } from "react";
import { VersionTimeline, VersionRegistration, VersionComparison, isVerified } from "./version-management";
import { LuDownload, LuX, LuHistory, LuBookOpen, LuGitCompareArrows, LuPlus } from "react-icons/lu";
import { VersionCandidates } from "./version-intelligence";
import { DocumentExport } from "./document-export";
import { DocumentReader } from "./document-reader";
import { fileStyle } from "./file-style";
import { downloadVersion, type WorkspaceDocument } from "./api";
import { api } from "@/lib/api";
import { message, statuses } from "@/lib/labels";
export function DocumentPreview({ document: initialDocument, editable, onClose, onChange, initialVersionId, initialBlockId }: { initialVersionId?: string; initialBlockId?: number; document: WorkspaceDocument; editable: boolean; onClose: () => void; onChange: () => void }) {
  const [document, setDocument] = useState(initialDocument);
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"preview" | "history" | "register" | "compare" | "intelligence" | "export">("preview");
  const [selectedId, setSelectedId] = useState(initialVersionId || document.current_version_id || document.versions.at(-1)?.id || "");
  const version = document.versions.find(v => v.id === selectedId) || document.versions.find(v => v.id === document.current_version_id) || document.versions.at(-1);
  const { kind, Icon, name } = fileStyle(version?.original_filename);
  const available = version && isVerified(version);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    async function load() {
      try { const latest = await api<WorkspaceDocument>(`/documents/${initialDocument.id}`); if (active) { setDocument(latest); setError(""); } }
      catch (err) { if (active) setError(message(err)); }
    }
    void load(); const interval = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(interval); };
  }, [initialDocument.id, revision]);
  function refresh() { setRevision(v => v + 1); onChange(); }
  async function download() {
    if (!version) return;
    setBusy(true); setError("");
    try { await downloadVersion(version.id); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className={`document-dialog preview-dialog ${tab === "compare" ? "compare-dialog" : ""} file-theme-${kind}`} aria-labelledby="preview-title" onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }}>
    <div className="preview-heading"><span className="preview-file-icon"><Icon /></span><div><p className="eyebrow">{name} · 텍스트 미리보기</p><h2 id="preview-title">{document.title}</h2><p className="muted">{version?.original_filename} · 수정 이력 {version?.version_number || 1} · {statuses[version?.status || "PENDING"]}{version?.id === document.current_version_id && " · 현재 수정 이력"}</p></div><button className="icon-button" aria-label="미리보기 닫기" onClick={onClose}><LuX /></button></div>
    <nav className="preview-tabs" aria-label="문서 수정 이력 메뉴"><button aria-pressed={tab === "preview"} onClick={() => setTab("preview")}><LuBookOpen /> 미리보기</button><button aria-label="수정 이력" aria-pressed={tab === "history"} onClick={() => setTab("history")}><LuHistory /> 수정 이력 <span>{document.versions.length}</span></button>{editable && <button aria-pressed={tab === "register"} onClick={() => setTab("register")}><LuPlus /> 새 수정 이력</button>}<button aria-pressed={tab === "compare"} disabled={document.versions.length < 2} onClick={() => setTab("compare")}><LuGitCompareArrows /> 수정 이력 비교</button><button aria-pressed={tab === "intelligence"} onClick={() => setTab("intelligence")}>수정 이력 후보</button><button aria-pressed={tab === "export"} onClick={() => setTab("export")}><LuDownload /> 내보내기</button></nav>
    <div className="panel-scroll preview-body">{tab === "export" && version && <DocumentExport key={version.id} version={version} />}{error && <p role="alert" className="error">{error}</p>}{tab === "preview" && <>{available ? <DocumentReader key={version.id} initialBlockId={version.id === initialVersionId ? initialBlockId : undefined} version={version} editable={editable} onChange={refresh} /> : <p className="notice">업로드를 완료하면 텍스트 미리보기가 표시됩니다. 문서 관리에서 업로드 상태를 확인해 주세요.</p>}</>}{tab === "history" && <VersionTimeline document={document} editable={editable} selectedId={selectedId} onSelect={id => { setSelectedId(id); setTab("preview"); }} onChange={refresh} />}{tab === "register" && editable && <VersionRegistration document={document} onChange={refresh} />}{tab === "intelligence" && version && <VersionCandidates key={version.id} document={document} version={version} editable={editable} onChange={refresh} />}{tab === "compare" && <VersionComparison document={document} editable={editable} onChange={refresh} />}</div>
    <footer className="preview-footer"><span>원본에서 추출한 텍스트입니다.</span>{available && <button className="secondary" disabled={busy} onClick={download}><LuDownload /> 원본 다운로드</button>}</footer>
  </dialog>;
}
