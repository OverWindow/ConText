"use client";

import { useEffect, useRef, useState } from "react";
import { LuSparkles, LuRefreshCw } from "react-icons/lu";
import { api } from "@/lib/api";
import { message } from "@/lib/labels";
import type { DocumentVersion, WorkspaceDocument } from "./api";

import type { Diff } from "../../shared/core/diff";
import { AIChangeSummary } from "../../shared/ui/ai-change-summary";
import { VersionCandidatesView } from "../../shared/ui/version-candidates";
import type { VersionCandidate as Candidate, VersionCandidates as Candidates } from "../../shared/core/versions";
import { DocumentDiff } from "../../shared/ui/document-diff";
type SummaryItem = { description: string; evidence_ids: string[] };
type Summary = { summary: string; added: SummaryItem[]; removed: SummaryItem[]; modified: SummaryItem[]; partial: boolean };
type Job = { state: "NOT_STARTED" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"; finished_at?: string; error_code?: string; result: { warnings: string[]; summary?: Summary | null; provenance?: { model?: string }; embedding_available?: boolean } | null };

const labels = { added: "추가", removed: "삭제", modified: "수정" };
const warnings: Record<string, string> = {
  AI_NOT_CONFIGURED: "AI 요약 설정이 필요합니다. 관리자에게 Mindlogic 연결 설정을 요청해 주세요.",
  EMBEDDING_NOT_CONFIGURED: "의미 분석 설정이 필요합니다. 현재 텍스트와 파일명으로 유사도를 비교합니다.",
  AI_UNAVAILABLE: "AI 서비스에 연결하지 못했습니다. 잠시 후 분석을 다시 요청할 수 있습니다.",
  AI_INVALID_RESPONSE: "AI 응답을 검증하지 못했습니다. 분석을 다시 요청해 주세요.",
  NO_TEXT_EVIDENCE: "분석할 텍스트 근거가 없습니다.",
  PARTIAL_DIFF: "일부 구간만 비교했습니다. 전체 문서의 동일 여부는 확인되지 않았습니다.",
};
const inProgress = (job: Job | undefined) => job?.state === "QUEUED" || job?.state === "RUNNING" || job?.state === "NOT_STARTED";
function JobNotice({ job }: { job: Job }) {
  return <>{job.state === "NOT_STARTED" && <p className="notice">아직 AI 분석 결과가 없습니다. 편집 권한이 있는 팀원이 분석을 요청할 수 있습니다.</p>}{job.state !== "NOT_STARTED" && inProgress(job) && <p className="notice" role="status">{job.state === "RUNNING" ? "AI 분석 중입니다." : "AI 분석을 기다리고 있습니다."}</p>}{job.state === "FAILED" && <p className="error" role="alert">분석을 완료하지 못했습니다. 다시 요청해 주세요.</p>}{job.result?.warnings?.map(code => <p className="notice" key={code}>{warnings[code] || "분석의 일부 결과를 제공하지 못했습니다."}</p>)}</>;
}

export function ChangeIntelligence({ documentId, left, right, editable }: { documentId: string; left: string; right: string; editable: boolean }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const scope = `${documentId}:${left}:${right}`;
  const query = `left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const results = await Promise.allSettled([
        api<Diff>(`/documents/${documentId}/diff?${query}`),
        api<Job>(`/documents/${documentId}/changes?${query}`),
      ]);
      if (!active) return;
      const [difference, analysis] = results;
      if (difference.status === "fulfilled") setDiff(difference.value);
      if (analysis.status === "fulfilled") setJob(analysis.value);
      const failure = results.find(r => r.status === "rejected");
      setError(failure?.status === "rejected" ? message(failure.reason) : "");
      if (analysis.status === "fulfilled" && inProgress(analysis.value) && analysis.value.state !== "NOT_STARTED") timer = setTimeout(() => void load(), 4000);
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [documentId, query, revision]);
  async function request() {
    setBusy(true); setError("");
    try {
      setJob(await api<Job>(`/documents/${documentId}/changes`, { method: "POST", body: JSON.stringify({ left, right }) }));
      setRevision(v => v + 1);
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  const summary = job?.result?.summary;
  return <section className="change-intelligence" aria-label="변경 분석">
    <div className="intelligence-heading"><h3><LuSparkles /> 변경 분석</h3>{editable && <button className="secondary" disabled={busy || job?.state === "QUEUED" || job?.state === "RUNNING"} onClick={() => void request()}><LuRefreshCw /> AI 요약 요청</button>}</div>
    {error && <p className="error" role="alert">{error} <button className="text-button" onClick={() => setRevision(v => v + 1)}>변경 분석 다시 불러오기</button></p>}
    {job && <JobNotice job={job} />}
    {summary && <AIChangeSummary summary={summary.summary} partial={summary.partial} sections={(["added", "removed", "modified"] as const).map(kind => ({ label: labels[kind], items: summary[kind] }))} scope={scope} model={job?.result?.provenance?.model} finishedAt={job?.finished_at} />}
    {diff && <DocumentDiff diff={diff} scope={scope} />}
  </section>;
}

type Intelligence = { analysis: Job; candidates: Candidates };
export function VersionCandidates({ document, version, editable, onChange }: { document: WorkspaceDocument; version: DocumentVersion; editable: boolean; onChange: () => void }) {
  const [data, setData] = useState<Intelligence | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState<string[]>([]);
  const [success, setSuccess] = useState("");
  const requests = useRef<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await api<Intelligence>(`/versions/${version.id}/intelligence`);
        if (!active) return;
        setData(response); setError("");
        if (inProgress(response.analysis) || response.candidates.pending > 0) timer = setTimeout(() => void load(), 4000);
      } catch (err) { if (active) setError(message(err)); }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [version.id, revision]);
  async function analyze() {
    setBusy(true); setError("");
    try { await api(`/versions/${version.id}/analyze`, { method: "POST" }); setRevision(v => v + 1); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function link(candidate: Candidate) {
    setBusy(true); setError("");
    try {
      requests.current[candidate.document_id] ??= crypto.randomUUID();
      await api(`/documents/${candidate.document_id}/versions/link`, { method: "POST", body: JSON.stringify({ request_id: requests.current[candidate.document_id], source_version_id: version.id, change_note: `수정 이력 후보 확인 후 연결: ${document.title}`.slice(0, 500) }) });
      setLinked(v => [...v, candidate.document_id]);
      setSuccess(`‘${candidate.document_title}’에 새 수정 이력으로 등록했습니다. 해당 문서의 수정 이력에서 현재 수정 이력을 지정할 수 있습니다.`); onChange();
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <VersionCandidatesView data={data?.candidates} busy={busy || version.status !== "READY" || data?.analysis.state === "RUNNING" || data?.analysis.state === "QUEUED"} editable={editable} error={error} success={success} linked={linked} analysis={data && <JobNotice job={data.analysis} />} onAnalyze={() => void analyze()} onRetry={() => setRevision(v => v + 1)} onLink={candidate => void link(candidate)} />;
}
