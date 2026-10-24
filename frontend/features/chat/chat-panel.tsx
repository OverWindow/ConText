"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LuBookOpen, LuMessageCircle, LuPlus, LuSearch, LuSend, LuPanelRightClose } from "react-icons/lu";
import { api, type Workspace } from "@/lib/api";
import { message } from "@/lib/labels";
import { DocumentPreview } from "@/features/documents/document-preview";
import type { WorkspaceDocument } from "@/features/documents/api";

type Scope = "auto" | "current" | "history" | "as_of";
export type DocumentReference = { document_id: string; version_number: number };
type Source = { id: string; chunk_id: string; document_id: string; document_title: string; version_id: string; version_number: number; is_current: boolean; text: string; locations: { block_id: number; page?: number; line?: number }[] };
type Evidence = { sources: Source[]; scope: Scope; as_of: string | null; warnings: string[] };
type Result = Evidence & { claims: { text: string; source_ids: string[] }[]; insufficient: boolean };
type ChatMessage = { id: string; role: "user" | "assistant"; state: string; content: string; error_code: string | null; result: Result | null; created_at: string };
type Session = { id: string; title: string };
type IndexCount = { versions: number; completed: number; failed: number; chunks: number; indexed_chunks: number };
type IndexStatus = { current: IndexCount; all: IndexCount };
const scopeLabels: Record<Scope, string> = { auto: "질문에 맞게", current: "현재 수정 이력", history: "과거 수정 이력 포함", as_of: "기준일 당시" };
const errorLabels: Record<string, string> = {
  AI_NOT_CONFIGURED: "AI 연결 설정이 필요합니다.", AI_FORBIDDEN: "AI 서비스에서 요청을 거절했습니다. 연결 권한을 확인해 주세요.",
  AI_UNAVAILABLE: "AI 서비스에 연결하지 못했습니다.", AI_INVALID_RESPONSE: "답변의 근거를 검증하지 못했습니다.",
  ACCESS_REVOKED: "질문자의 워크스페이스 접근 권한이 변경되었습니다.",
};

export function ChatPanel({ workspace, open, onClose, onRevealSources }: { workspace: Workspace; open: boolean; onClose: () => void; onRevealSources: (sources: DocumentReference[]) => void }) {
  const panel = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<"chat" | "search">("chat");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<Scope>("auto");
  const [asOf, setAsOf] = useState("");
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [results, setResults] = useState<Evidence | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{ document: WorkspaceDocument; source: Source } | null>(null);
  const pending = useRef<{ signature: string; requestId: string; sessionRequestId: string; sessionId?: string } | null>(null);
  const scopeRef = useRef(0);
  const revealed = useRef("");
  const [searchRevision, setSearchRevision] = useState(0);
  const messageEnd = useRef<HTMLDivElement>(null);
  const base = `/workspaces/${workspace.id}`;
  const waiting = messages.some(m => ["QUEUED", "RUNNING"].includes(m.state));
  useEffect(() => { if (open) panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    async function load() {
      try {
        const [list, status] = await Promise.all([api<Session[]>(`${base}/chat/sessions?offset=${offset}`), api<IndexStatus>(`${base}/rag/status`)]);
        if (!active) return;
        setSessions(current => offset === 0 ? list : [...current, ...list.filter(s => !current.some(c => c.id === s.id))]);
        setHasMore(list.length === 50); setIndex(status); setLoading(false);
      } catch (err) { if (active) { setError(message(err)); setLoading(false); } }
    }
    void load(); const timer = setInterval(() => void load(), 6000);
    return () => { active = false; clearInterval(timer); };
  }, [base, revision, offset, open]);
  useEffect(() => {
    if (!open || !sessionId) return;
    let active = true;
    async function load() {
      try { const list = await api<ChatMessage[]>(`${base}/chat/sessions/${sessionId}/messages`); if (active) setMessages(list); }
      catch (err) { if (active) setError(message(err)); }
    }
    void load(); const timer = setInterval(() => void load(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [base, sessionId, revision, open]);
  const lastState = messages.at(-1)?.state;
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, lastState]);
  const latestAnswer = messages.findLast(item => item.role === "assistant");
  const visibleSources = mode === "search" ? results?.sources : latestAnswer?.state === "COMPLETED" ? latestAnswer.result?.sources : undefined;
  const referencePayload = JSON.stringify((visibleSources || []).map(({ document_id, version_number }) => ({ document_id, version_number })));
  const referenceKey = JSON.stringify([open, mode, sessionId, mode === "search" ? searchRevision : latestAnswer?.id, referencePayload]);
  useEffect(() => {
    // Polling refreshes message objects; only a newly displayed answer should move the canvas.
    if (revealed.current === referenceKey) return;
    revealed.current = referenceKey;
    onRevealSources(open ? JSON.parse(referencePayload) as DocumentReference[] : []);
  }, [open, referenceKey, referencePayload, onRevealSources]);
  function chooseSession(id: string) {
    scopeRef.current += 1; setSessionId(id); setMessages([]); setQuestion(""); setError(""); setNotice(""); pending.current = null;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!question.trim() || busy || (mode === "chat" && waiting)) return;
    const generation = scopeRef.current;
    setBusy(true); setError(""); setNotice("");
    const options = { question: question.trim(), scope, as_of: scope === "as_of" ? asOf : null };
    try {
      if (mode === "search") {
        const result = await api<Evidence>(`${base}/search`, { method: "POST", body: JSON.stringify(options) });
        if (generation === scopeRef.current) { setResults(result); setSearchRevision(value => value + 1); }
      } else {
        const signature = JSON.stringify({ sessionId, ...options });
        if (!pending.current || pending.current.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID(), sessionRequestId: crypto.randomUUID() };
        const request = pending.current;
        let id = request.sessionId || sessionId;
        if (!id) {
          const session = await api<Session>(`${base}/chat/sessions`, { method: "POST", body: JSON.stringify({ request_id: request.sessionRequestId, title: options.question.slice(0, 80) }) });
          id = session.id; request.sessionId = id;
        }
        const answer = await api<ChatMessage>(`${base}/chat/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ ...options, request_id: request.requestId }) });
        if (generation !== scopeRef.current) return;
        setSessionId(id); setMessages(current => current.some(m => m.id === answer.id) ? current : [...current, answer]); setQuestion(""); pending.current = null; setRevision(v => v + 1);
      }
    } catch (err) { if (generation === scopeRef.current) setError(message(err)); } finally { setBusy(false); }
  }
  async function retry(id: string) {
    setBusy(true); setError("");
    try { await api(`${base}/chat/sessions/${sessionId}/messages/${id}/retry`, { method: "POST" }); setRevision(v => v + 1); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function reindex() {
    setBusy(true); setError("");
    try { await api(`${base}/rag/reindex`, { method: "POST" }); setNotice("문서 색인 재시도를 요청했습니다. 처리 상태가 갱신될 때까지 기다려 주세요."); setRevision(v => v + 1); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function openSource(source: Source) {
    setError("");
    try {
      const document = await api<WorkspaceDocument>(`/documents/${source.document_id}`);
      if (!document.versions.some(v => v.id === source.version_id)) throw new Error("인용한 수정 이력을 찾을 수 없습니다.");
      setPreview({ document, source });
    } catch (err) { setError(message(err)); }
  }
  function sources(items: Source[], prefix = "search") {
    return <div className="chat-sources">{items.map(source => <details className="chat-source" key={source.id} id={`${prefix}-source-${source.chunk_id}`}><summary onClick={() => onRevealSources([source])}><LuBookOpen /><strong>{source.id} · {source.document_title}</strong><span>이력 {source.version_number} · {source.is_current ? "검색 당시 현재 수정 이력" : "과거 수정 이력"}{source.locations[0]?.page ? ` · ${source.locations[0].page}페이지` : ` · 문단 ${source.locations[0]?.block_id || 1}`}</span></summary><p className="source-excerpt">{source.text}</p><button className="secondary" onClick={() => void openSource(source)}>인용한 수정 이력 열기</button></details>)}</div>;
  }
  function warning(result: Evidence) { return <>{result.warnings.includes("INDEX_INCOMPLETE") && <p className="notice">일부 문서의 색인이 완료되지 않아 검색에서 빠질 수 있습니다.</p>}{result.warnings.includes("SEMANTIC_UNAVAILABLE") && <p className="notice">의미 검색을 사용할 수 없어 텍스트로 검색했습니다.</p>}</>; }
  return <><aside ref={panel} id="workspace-chat" className="chat-panel" aria-labelledby="chat-title" hidden={!open} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="chat-heading"><div><p className="eyebrow">{workspace.name} · 팀과 공유하는 대화</p><h2 id="chat-title"><LuMessageCircle /> 문서 AI 채팅</h2></div><button className="icon-button" aria-label="AI 채팅 접기" title="AI 채팅 접기" aria-expanded={open} aria-controls="workspace-chat" onClick={onClose}><LuPanelRightClose /></button></header>
    <div className="chat-toolbar"><div className="chat-mode"><button disabled={busy} aria-pressed={mode === "chat"} onClick={() => { setMode("chat"); setError(""); }}>대화</button><button disabled={busy} aria-pressed={mode === "search"} onClick={() => { setMode("search"); setError(""); }}>문서 검색</button></div><label className="chat-session-select">대화 기록<select aria-label="대화 기록" value={sessionId} disabled={busy} onChange={e => chooseSession(e.target.value)}><option value="">새 대화</option>{sessions.map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select></label><button className="secondary" disabled={busy} onClick={() => chooseSession("")}><LuPlus /> 새 대화</button>{hasMore && <button className="text-button" onClick={() => setOffset(v => v + 50)}>이전 대화 더 보기</button>}</div>
    <div className="chat-index"><span>{index ? `현재 문서 ${index.current.completed}/${index.current.versions}개 검색 준비 · 전체 ${index.all.indexed_chunks}/${index.all.chunks}개 구간 색인` : "검색 준비 상태 확인 중…"}</span>{workspace.role !== "VIEWER" && <button className="text-button" disabled={busy} onClick={() => void reindex()}>색인 다시 시도</button>}</div>
    {error && <p role="alert" className="error chat-alert">{error} <button className="text-button" onClick={() => setRevision(v => v + 1)}>다시 불러오기</button></p>}{notice && <p role="status" className="notice chat-alert">{notice}</p>}
    <div className="chat-scroll" aria-label={mode === "chat" ? "대화 내용" : "문서 검색 결과"}>
      {loading && <p role="status">대화 목록을 불러오는 중…</p>}
      {mode === "chat" ? <>{!sessionId && messages.length === 0 && <div className="chat-empty"><LuBookOpen /><h3>팀 문서에 질문해 보세요</h3><p>현재 수정 이력을 우선 검색하고, 답변에 문서·수정 이력·본문 근거를 붙입니다.</p><button className="secondary" onClick={() => setQuestion("현재 우리 팀의 가격 정책을 정리해줘")}>현재 가격 정책을 정리해줘</button></div>}{messages.map(m => <article key={m.id} className={`chat-message chat-${m.role}`} aria-label={m.role === "user" ? "팀원 질문" : "AI 답변"}><strong>{m.role === "user" ? "팀원 질문" : "문서 AI"}</strong>{["QUEUED", "RUNNING"].includes(m.state) ? <p role="status">{m.state === "QUEUED" ? "답변을 준비하고 있습니다…" : "문서를 찾아 답변하고 있습니다…"}</p> : m.state === "FAILED" ? <div><p className="error">{errorLabels[m.error_code || ""] || "답변을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."}</p>{messages.at(-1)?.id === m.id && <button className="secondary" disabled={busy} onClick={() => void retry(m.id)}>답변 다시 시도</button>}</div> : m.result ? <><p className="muted">검색 범위: {scopeLabels[m.result.scope]} {m.result.as_of}</p>{warning(m.result)}{m.result.claims.length ? m.result.claims.map((claim, i) => <p className="chat-claim" key={i}>{claim.text} <span className="citation-buttons">{claim.source_ids.map(ref => <button key={ref} className="citation" aria-label={`${ref} 근거 보기`} onClick={e => { const source = m.result!.sources.find(s => s.id === ref); if (!source) return; onRevealSources([source]); const article = e.currentTarget.closest("article"); const target = article?.querySelector<HTMLDetailsElement>(`[id="${m.id}-source-${source.chunk_id}"]`); if (target) { target.open = true; target.scrollIntoView({ block: "nearest", behavior: "smooth" }); } }}>{ref}</button>)}</span></p>) : <p>{m.content}</p>}{m.result.insufficient && m.result.claims.length > 0 && <p className="notice">일부 질문에는 충분한 근거가 없습니다.</p>}{sources(m.result.sources, m.id)}</> : <p className="chat-question-text">{m.content}</p>}</article>)}<div ref={messageEnd} /></> : results ? <><p className="muted">{scopeLabels[results.scope]} {results.as_of} · {results.sources.length}개 검색 결과</p>{warning(results)}{results.sources.length ? sources(results.sources) : <p>관련 문서를 찾지 못했습니다. 검색어와 범위를 바꿔 보세요.</p>}</> : <div className="chat-empty"><LuSearch /><h3>문서 내용으로 검색</h3><p>질문과 의미가 비슷한 본문을 찾아 출처를 확인합니다.</p></div>}
    </div>
    <form className="chat-composer" onSubmit={submit}><div className="chat-scope"><label>검색 범위<select aria-label="검색 범위" value={scope} disabled={busy} onChange={e => setScope(e.target.value as Scope)}>{Object.entries(scopeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{scope === "as_of" && <label>기준 날짜<input type="date" aria-label="기준 날짜" required value={asOf} disabled={busy} onChange={e => setAsOf(e.target.value)} /></label>}<small>{scope === "as_of" ? "한국 시간 기준, 해당 날짜까지 등록된 가장 높은 수정 이력 번호를 검색합니다." : "답변은 인용된 원문과 함께 확인해 주세요."}</small></div><div className="chat-input-row"><textarea aria-label="문서 질문" placeholder={mode === "chat" ? "문서에 대해 질문하세요…" : "찾고 싶은 내용을 입력하세요…"} maxLength={2000} required value={question} disabled={busy} onChange={e => setQuestion(e.target.value)} /><button className="primary" disabled={busy || !question.trim() || (mode === "chat" && waiting) || (scope === "as_of" && !asOf)}><LuSend />{busy ? "요청 중…" : mode === "chat" ? "질문 보내기" : "검색하기"}</button></div></form>
  </aside>{preview && <DocumentPreview key={`${preview.document.id}:${preview.source.version_id}`} document={preview.document} editable={workspace.role !== "VIEWER"} initialVersionId={preview.source.version_id} initialBlockId={preview.source.locations[0]?.block_id} onClose={() => setPreview(null)} onChange={() => setRevision(v => v + 1)} />}</>;
}
