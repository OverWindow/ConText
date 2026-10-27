"use client";
import { useEffect, useState } from "react";
import { LuBookOpen, LuRefreshCw, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { api } from "@/lib/api";
import { message } from "@/lib/labels";
import type { DocumentVersion } from "./api";
import { DocumentBlocks } from "../../shared/ui/document-blocks";
import type { NormalizedBlock as Block } from "../../shared/core/documents";
type Content = { blocks: Block[]; total: number; next_offset: number | null; warnings: string[] };
type Job = { state: string; error_message: string | null; summary: { block_count: number; character_count: number; page_count: number | null; warnings: string[] } | null };
export function DocumentReader({ version, editable, onChange, initialBlockId }: { initialBlockId?: number; version: DocumentVersion; editable: boolean; onChange: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await api<Job>(`/versions/${version.id}/processing`);
        if (!active) return;
        setJob(result); setError("");
        if (result.state === "COMPLETED") {
          const text = await api<Content>(`/versions/${version.id}/content${initialBlockId ? `?offset=${Math.max(0, initialBlockId - 1)}` : ""}`);
          if (active) setContent(text);
        }
      } catch (err) { if (active) setError(message(err)); }
    }
    void load();
    const interval = setInterval(() => { if (version.status !== "READY" && version.status !== "FAILED") void load(); }, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [version.id, version.status, revision, initialBlockId]);
  async function retry() {
    setBusy(true); setError("");
    try { await api(`/versions/${version.id}/process`, { method: "POST" }); setRevision(v => v + 1); onChange(); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function more() {
    if (!content || content.next_offset === null) return;
    setBusy(true);
    try { const next = await api<Content>(`/versions/${version.id}/content?offset=${content.next_offset}`); setContent({ ...next, blocks: [...content.blocks, ...next.blocks] }); setError(""); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <section className="reader" aria-label="문서 본문">
    <h3><LuBookOpen /> 문서 본문</h3>
    {error && <p role="alert" className="error">{error} <button className="text-button" onClick={() => setRevision(v => v + 1)}>다시 불러오기</button></p>}
    {!job && !error && <p role="status" className="muted">처리 상태를 확인하고 있습니다…</p>}
    {job && ["QUEUED", "RUNNING"].includes(job.state) && <div className="processing-notice" role="status"><LuLoaderCircle className="spin" /><strong>{job.state === "QUEUED" ? "문서 처리 대기 중" : "문서를 읽고 있습니다"}</strong><p>완료되면 본문이 자동으로 표시됩니다.</p></div>}
    {job?.state === "FAILED" && <div className="notice"><LuTriangleAlert /><p>{job.error_message || "문서를 처리하지 못했습니다."}</p>{editable && <button className="secondary" disabled={busy} onClick={retry}><LuRefreshCw /> 다시 처리</button>}</div>}
    {job?.summary && <p className="muted reader-meta">{job.summary.block_count}개 문단 · {job.summary.character_count.toLocaleString("ko-KR")}자{job.summary.page_count ? ` · ${job.summary.page_count}페이지` : ""}</p>}
    {content?.warnings.map((warning, i) => <p className="notice" key={i}>{warning}</p>)}
    {content && <DocumentBlocks blocks={content.blocks} initialBlockId={initialBlockId} />}
    {content?.next_offset != null && <button className="secondary wide" disabled={busy} onClick={more}>{busy ? "불러오는 중…" : "다음 문단 보기"}</button>}
  </section>;
}
