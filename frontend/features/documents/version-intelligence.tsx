"use client";

import { useEffect, useRef, useState } from "react";
import { LuSparkles, LuLink, LuRefreshCw } from "react-icons/lu";
import { api } from "@/lib/api";
import { message } from "@/lib/labels";
import type { DocumentVersion, WorkspaceDocument } from "./api";

type Evidence = { id: number; type: string; level?: number; source: { page?: number }; text: string; truncated: boolean };
type Change = { id: string; kind: "added" | "removed" | "modified"; before: Evidence | null; after: Evidence | null; text_diff: { kind: "equal" | "added" | "removed"; text: string }[] };
type Diff = { counts: { added: number; removed: number; modified: number; unchanged: number }; changes: Change[]; total_changes: number; truncated: boolean };
type SummaryItem = { description: string; evidence_ids: string[] };
type Summary = { summary: string; added: SummaryItem[]; removed: SummaryItem[]; modified: SummaryItem[]; partial: boolean };
type Job = { state: "NOT_STARTED" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"; finished_at?: string; error_code?: string; result: { warnings: string[]; summary?: Summary | null; provenance?: { model?: string }; embedding_available?: boolean } | null };
const blockLabel = (b: Evidence) => b.type === "heading" ? `제목${b.level ? ` ${b.level}단계` : ""}` : b.type === "table" ? "표" : "문단";
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
    {summary && <article className="ai-change-summary" aria-label="AI 변경 요약"><h4>AI 변경 요약</h4><p>{summary.summary}</p>{summary.partial && <p className="notice">일부 변경 근거를 요약했습니다. 전체 변경 목록과 원문을 함께 확인해 주세요.</p>}{(["added", "removed", "modified"] as const).map(kind => summary[kind].length > 0 && <div key={kind}><strong>{labels[kind]}</strong><ul>{summary[kind].map((item, index) => <li key={index}>{item.description} <span className="evidence-links">{item.evidence_ids.map(id => <a key={id} href={`#${scope}-${id}`}>근거 {id.replace("change-", "")}</a>)}</span></li>)}</ul></div>)}<p className="muted">{job?.result?.provenance?.model} · {job?.finished_at && new Date(job.finished_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} · AI 해석은 원문 근거와 함께 확인해 주세요.</p></article>}
    {diff && <><div className="diff-counts" aria-label="변경 개수"><span className="diff-added">추가 {diff.counts.added}</span><span className="diff-removed">삭제 {diff.counts.removed}</span><span>수정 {diff.counts.modified}</span><span className="muted">유지 {diff.counts.unchanged}</span></div>{diff.truncated && <p className="notice">큰 문서이거나 변경 내용이 많아 일부만 표시합니다. 원문 비교도 확인해 주세요.</p>}{diff.total_changes === 0 && <p>{diff.truncated ? "비교한 구간에서 텍스트·구조 변경을 찾지 못했습니다." : "텍스트·구조 변경이 없습니다. 파일 형식이나 서식은 다를 수 있습니다."}</p>}
      <div className="diff-list">{diff.changes.map(change => <article id={`${scope}-${change.id}`} className={`diff-block diff-${change.kind}`} key={change.id}><header><strong>{labels[change.kind]} · 근거 {change.id.replace("change-", "")}</strong><span className="muted">{change.before && `이전 ${blockLabel(change.before)} ${change.before.id}${change.before.source.page ? ` (${change.before.source.page}쪽)` : ""}`}{change.before && change.after && " → "}{change.after && `비교 ${blockLabel(change.after)} ${change.after.id}${change.after.source.page ? ` (${change.after.source.page}쪽)` : ""}`}</span></header><p className="diff-text">{change.text_diff.map((part, index) => part.kind === "added" ? <ins key={index}>{part.text}</ins> : part.kind === "removed" ? <del key={index}>{part.text}</del> : <span key={index}>{part.text}</span>)}</p>{change.before?.truncated || change.after?.truncated ? <small>긴 문단의 앞부분만 표시합니다.</small> : null}</article>)}</div>
    </>}
  </section>;
}

type Candidate = { document_id: string; document_title: string; version_id: string; version_number: number; score: number; exact_duplicate: boolean; filename_similarity: number; text_similarity: number; embedding_similarity: number | null; sampled: boolean };
type Intelligence = { analysis: Job; candidates: { items: Candidate[]; scanned: number; total: number; pending: number; limited: boolean } };
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
  const percent = (n: number) => `${Math.round(n * 100)}%`;
  return <section className="version-candidates" aria-label="수정 이력 후보 추천"><div className="intelligence-heading"><h3><LuSparkles /> 수정 이력 후보 추천</h3>{editable && <button className="secondary" onClick={() => void analyze()} disabled={busy || version.status !== "READY" || data?.analysis.state === "RUNNING" || data?.analysis.state === "QUEUED"}><LuRefreshCw /> 후보 분석 요청</button>}</div><p className="muted">이 파일과 비슷한 같은 워크스페이스의 현재 수정 이력입니다. 점수는 비교 지표이며 같은 문서일 확률이 아닙니다.</p><p className="notice">연결할 후보를 선택하지 않으면 별도 문서로 유지됩니다. 연결하면 원본을 보존한 채 선택한 문서에 새 수정 이력을 추가합니다.</p>
    {error && <p className="error" role="alert">{error} <button className="text-button" onClick={() => setRevision(v => v + 1)}>후보 다시 불러오기</button></p>}{success && <p className="success-message" role="status">{success}</p>}
    {data && <><JobNotice job={data.analysis} /><p className="muted">현재 수정 이력 {data.candidates.scanned}개 비교{data.candidates.pending > 0 && ` · ${data.candidates.pending}개 텍스트 분석 대기`}{data.candidates.limited && " · 최근 문서 500개 범위"}</p>{data.candidates.items.length === 0 && <p>추천할 수정 이력 후보가 없습니다.</p>}{data.candidates.items.map(candidate => <article className="candidate-card" key={candidate.document_id}><div className="intelligence-heading"><h4>{candidate.document_title} · 수정 이력 {candidate.version_number}</h4><span className="badge">{candidate.exact_duplicate ? "동일 파일" : `유사도 ${percent(candidate.score)}`}</span></div><p className="muted">파일명 {percent(candidate.filename_similarity)} · 텍스트 {percent(candidate.text_similarity)} · 의미 {candidate.embedding_similarity === null ? "미분석" : percent(candidate.embedding_similarity)}{candidate.sampled && " · 앞부분 표본 비교"}</p>{editable && !candidate.exact_duplicate && <button className="secondary" disabled={busy || linked.includes(candidate.document_id) || version.status !== "READY"} onClick={() => void link(candidate)}><LuLink />{linked.includes(candidate.document_id) ? "연결 완료" : `‘${candidate.document_title}’의 새 수정 이력으로 등록`}</button>}{candidate.exact_duplicate && <p>동일한 파일이 이미 등록되어 있습니다.</p>}</article>)}</>}
  </section>;
}
