"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LuDatabase, LuHistory, LuLoaderCircle, LuEllipsis, LuPanelRightClose, LuPlus, LuRefreshCw, LuSend, LuSettings2, LuSlidersHorizontal, LuSparkles, LuTriangleAlert, LuUser } from "react-icons/lu";
import { sourceLabel, type Source } from "../core/sources";
import type { ChatRepository, Scope, Evidence, ChatMessage, Session, IndexStatus, DocumentReference } from "../core/chat";
import { SourceExcerpts } from "../ui/source-excerpts";
import "./chat.css";
import { usePanelPresence } from "./use-panel-presence";

const message = (error: unknown) => error instanceof Error ? error.message : "요청을 완료하지 못했습니다.";
const scopeLabels: Record<Scope, string> = { auto: "자동", current: "현재 수정 이력", history: "과거 포함", as_of: "기준일" };
const errorLabels: Record<string, string> = {
  AI_RATE_LIMITED: "ChatKHU 크레딧 또는 사용량 한도에 도달했습니다.",
  AI_TIMEOUT: "AI 응답을 확인하지 못했습니다. 재시도하면 추가로 사용량이 발생할 수 있습니다.",
  AI_UNSUPPORTED_REQUEST: "선택한 모델의 지원 형식과 입력 크기를 확인해 주세요.",
  AI_REQUEST_ALREADY_SUBMITTED: "이미 접수된 요청입니다. 이전 처리 상태를 먼저 확인해 주세요.",
  WORKER_INTERRUPTED: "앱이 종료되어 응답을 확인하지 못했습니다. 재시도하면 추가로 사용량이 발생할 수 있습니다.",
  AI_NOT_CONFIGURED: "AI 연결 설정이 필요합니다.",
  AI_FORBIDDEN: "AI 연결 권한을 확인해 주세요.",
  AI_UNAVAILABLE: "AI 서비스에 연결하지 못했습니다.",
  AI_INVALID_RESPONSE: "답변의 근거를 검증하지 못했습니다.",
  ACCESS_REVOKED: "워크스페이스 접근 권한이 변경되었습니다.",
};
const warningLabels: Record<string, string> = {
  SAMPLE_HISTORY_UNAVAILABLE: "샘플에는 기준일별 수정 이력이 없습니다. 현재 수정 이력으로 질문해 주세요.",
  SAMPLE_CURRENT_ONLY: "샘플은 현재 수정 이력 한 개만 제공합니다.",
  INDEX_INCOMPLETE: "일부 문서의 색인이 완료되지 않아 검색에서 빠질 수 있습니다.",
  SEMANTIC_UNAVAILABLE: "의미 검색을 사용할 수 없어 텍스트로 검색했습니다.",
};
type Retrieval = { id: string; question: string; evidence: Evidence | null; previousIds: string[]; answerId?: string };

function combineEvidence(answer: Evidence | null | undefined, retrieved: Evidence | null | undefined): Evidence | null {
  if (!answer) return retrieved || null;
  if (!retrieved) return answer;
  const keys = new Set(answer.sources.map(source => `${source.version_id}:${source.chunk_id}`));
  const extra = retrieved.sources.filter(source => !keys.has(`${source.version_id}:${source.chunk_id}`))
    .map(source => ({ ...source, id: `retrieved:${source.version_id}:${source.chunk_id}` }));
  return { ...answer, sources: [...answer.sources, ...extra], warnings: [...new Set([...answer.warnings, ...retrieved.warnings])] };
}

export function ChatPanelView({ workspace, repository, open, onClose, onRevealSources, onOpenSource, onAISettings }: {
  workspace: { id: string; name: string; role: "OWNER" | "EDITOR" | "VIEWER" }; repository: ChatRepository; open: boolean;
  onClose: () => void; onRevealSources: (sources: DocumentReference[]) => void; onOpenSource: (source: Source) => Promise<void>; onAISettings?: () => void;
}) {
  const presence = usePanelPresence(open);
  const panel = useRef<HTMLElement>(null), messageEnd = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<Session[]>([]), [sessionId, setSessionId] = useState("");
  const [offset, setOffset] = useState(0), [hasMore, setHasMore] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]), [question, setQuestion] = useState("");
  const [scope, setScope] = useState<Scope>("auto"), [asOf, setAsOf] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false), [index, setIndex] = useState<IndexStatus | null>(null);
  const [retrieval, setRetrieval] = useState<Retrieval | null>(null);
  const [retrievedSources, setRetrievedSources] = useState<Record<string, Evidence>>({});
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [requestError, setRequestError] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [loadingMessages, setLoadingMessages] = useState(false);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false), scopeRef = useRef(0), revealed = useRef("");
  const pending = useRef<{ signature: string; requestId: string; sessionRequestId: string; sessionId?: string } | null>(null);
  const waiting = messages.some(item => ["QUEUED", "RUNNING"].includes(item.state));
  useEffect(() => () => { scopeRef.current += 1; }, []);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    async function load() {
      try {
        const [list, status] = await Promise.all([repository.sessions(offset), repository.indexStatus()]);
        if (!active) return;
        setSessions(current => offset === 0 ? list : [...current, ...list.filter(item => !current.some(previous => previous.id === item.id))]);
        setHasMore(list.length === 50); setIndex(status); setLoading(false);
      } catch (err) { if (active) { setRequestError(false); setError(message(err)); setLoading(false); } }
    }
    void load(); const timer = setInterval(() => void load(), 6000);
    return () => { active = false; clearInterval(timer); };
  }, [repository, revision, offset, open]);
  useEffect(() => {
    if (!open || !sessionId) return;
    let active = true;
    async function load() {
      try { const list = await repository.messages(sessionId); if (active) { setMessages(list); setLoadingMessages(false); } }
      catch (err) { if (active) { setRequestError(false); setError(message(err)); setLoadingMessages(false); } }
    }
    void load(); const timer = setInterval(() => void load(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [repository, sessionId, revision, open]);
  const activeAnswer = retrieval ? messages.find((item, i) => item.role === "assistant" && (retrieval.answerId ? item.id === retrieval.answerId : !retrieval.previousIds.includes(item.id) && messages[i - 1]?.role === "user" && messages[i - 1]?.content === retrieval.question)) : undefined;
  const latestAnswer = [...messages].reverse().find(item => item.role === "assistant");
  const visibleEvidence = retrieval ? combineEvidence(activeAnswer?.result, retrieval.evidence) : combineEvidence(latestAnswer?.result, latestAnswer && retrievedSources[latestAnswer.id]);
  const referencePayload = JSON.stringify([...new Map((visibleEvidence?.sources || []).map(({ document_id, version_number }) => [`${document_id}:${version_number}`, { document_id, version_number }])).values()]);
  const revealCallback = useRef(onRevealSources);
  useEffect(() => { revealCallback.current = onRevealSources; }, [onRevealSources]);
  const referenceKey = JSON.stringify([open, sessionId, retrieval?.id || latestAnswer?.id, referencePayload]);
  useEffect(() => {
    if (revealed.current === referenceKey) return;
    revealed.current = referenceKey;
    if (!open) { revealCallback.current([]); return; }
    const timer = setTimeout(() => revealCallback.current(JSON.parse(referencePayload) as DocumentReference[]), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300);
    return () => { clearTimeout(timer); revealed.current = ''; };
  }, [open, referenceKey, referencePayload]);
  const lastState = messages.at(-1)?.state, retrievedCount = retrieval?.evidence?.sources.length;
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, lastState, retrievedCount]);

  function rememberEvidence() {
    if (activeAnswer && retrieval?.evidence) setRetrievedSources(current => ({ ...current, [activeAnswer.id]: retrieval.evidence! }));
  }
  function chooseSession(id: string) {
    rememberEvidence();
    scopeRef.current += 1; setSessionId(id); setMessages([]); setRetrieval(null); setLoadingMessages(!!id);
    setQuestion(""); setError(""); setNotice(""); pending.current = null;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || inFlight.current || waiting || loadingMessages || scope === "as_of" && !asOf) return;
    rememberEvidence();
    const generation = scopeRef.current;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    const options = { question: question.trim(), scope, as_of: scope === "as_of" ? asOf : null };
    const signature = JSON.stringify({ sessionId, ...options });
    if (!pending.current || pending.current.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID(), sessionRequestId: crypto.randomUUID() };
    const request = pending.current;
    setRetrieval(current => current?.id === request.requestId ? current : { id: request.requestId, question: options.question, evidence: null, previousIds: messages.map(item => item.id) });
    try {
      const evidence = await repository.search(options);
      if (generation !== scopeRef.current) return;
      setRetrieval(current => current?.id === request.requestId ? { ...current, evidence } : current);
      let id = request.sessionId || sessionId;
      if (!id) {
        const session = await repository.createSession({ requestId: request.sessionRequestId, title: options.question.slice(0, 80) });
        id = session.id; request.sessionId = id;
        request.signature = JSON.stringify({ sessionId: id, ...options });
      }
      if (generation !== scopeRef.current) return;
      setSessionId(id);
      const answer = await repository.ask(id, { ...options, requestId: request.requestId });
      if (generation !== scopeRef.current) return;
      setRetrieval(current => current?.id === request.requestId ? { ...current, answerId: answer.id } : current);
      setMessages(current => current.some(item => item.id === answer.id) ? current : [...current, { id: `${request.requestId}:user`, role: "user", state: "COMPLETED", content: options.question, result: null, error_code: null, created_at: new Date().toISOString() }, answer]);
      setQuestion(""); pending.current = null; setRevision(value => value + 1);
    } catch (err) { if (generation === scopeRef.current) { setRequestError(true); setError(message(err)); setRevision(value => value + 1); } }
    finally { inFlight.current = false; if (generation === scopeRef.current) setBusy(false); }
  }
  async function retry(id: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await repository.retry(sessionId, id); setRevision(value => value + 1); }
    catch (err) { setRequestError(false); setError(message(err)); } finally { inFlight.current = false; setBusy(false); }
  }
  async function reindex() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await repository.reindex(); setNotice("문서를 다시 준비하고 있어요."); setRevision(value => value + 1); }
    catch (err) { setRequestError(false); setError(message(err)); } finally { inFlight.current = false; setBusy(false); }
  }
  async function openSource(source: Source) {
    setError("");
    try { await onOpenSource(source); } catch (err) { setRequestError(false); setError(message(err)); }
  }
  function sources(evidence: Evidence, prefix: string, showEmpty = true, insufficient = false) {
    const warnings = evidence.warnings.map(code => warningLabels[code]).filter(Boolean);
    if (insufficient) warnings.push("일부 질문에는 충분한 근거가 없습니다.");
    return <div className="chat-evidence" title={scopeLabels[evidence.scope]}>{(evidence.as_of || warnings.length > 0) && <div className="chat-evidence-meta">{evidence.as_of && <time>{evidence.as_of}</time>}{warnings.map(label => <span className="chat-evidence-warning" key={label} role="status" aria-label={label} title={label}><LuTriangleAlert aria-hidden="true" /></span>)}</div>}<SourceExcerpts items={evidence.sources} prefix={prefix} onOpen={source => void openSource(source)} onReveal={source => onRevealSources([source])} />{showEmpty && !evidence.sources.length && <p className="chat-no-results">관련 문서를 찾지 못했어요.</p>}</div>;
  }
  const indexLabel = index ? `현재 문서 ${index.current.completed}/${index.current.versions}개 검색 준비 · 전체 ${index.all.indexed_chunks}/${index.all.chunks}개 구간 색인` : "검색 준비 상태 확인 중";
  const hasQuestion = retrieval && messages.some(item => item.role === "user" && !retrieval.previousIds.includes(item.id) && item.content === retrieval.question);
  const blocked = busy || waiting || loadingMessages;
  return <div className="chat-drawer" data-open={open} data-phase={presence.phase} hidden={presence.hidden} inert={!open}><aside ref={panel} id="workspace-chat" className="chat-panel chat-unified" aria-label="AI 채팅과 문서 검색" hidden={presence.hidden} aria-hidden={!open} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (filtersOpen) setFiltersOpen(false); else onClose(); } }}>
    <header className="chat-heading"><div><h2><LuSparkles aria-hidden="true" />AI</h2><span className="chat-workspace" title={workspace.name}>{workspace.name}</span></div><button className="icon-button" aria-label="AI 채팅 접기" title="접기" aria-expanded={open} aria-controls="workspace-chat" onClick={onClose}><LuPanelRightClose /></button></header>
    <div className="chat-toolbar"><label className="chat-session-select" title="대화 기록"><LuHistory aria-hidden="true" /><select aria-label="대화 기록" value={sessionId} disabled={busy} onChange={event => chooseSession(event.target.value)}><option value="">새 대화</option>{sessions.map(session => <option value={session.id} key={session.id}>{session.title}</option>)}</select></label><button className="icon-button" aria-label="새 대화" title="새 대화" disabled={busy} onClick={() => chooseSession("")}><LuPlus /></button>{hasMore && <button className="icon-button" aria-label="이전 대화 더 보기" title="이전 대화 더 보기" disabled={busy} onClick={() => setOffset(value => value + 50)}><LuEllipsis /></button>}<span className="chat-index-indicator" role="status" aria-label={indexLabel} title={indexLabel}>{index ? <><LuDatabase aria-hidden="true" />{index.current.completed}/{index.current.versions}</> : <LuLoaderCircle className="spin" aria-hidden="true" />}</span></div>
    {error && (!requestError || activeAnswer?.state !== "FAILED") && <div role="alert" className="error chat-alert"><span>{error}</span>{requestError && onAISettings && <button className="icon-button" aria-label="AI 연결 설정" title="AI 연결 설정" onClick={onAISettings}><LuSettings2 /></button>}<button className="icon-button" aria-label="다시 불러오기" title="다시 불러오기" onClick={() => setRevision(value => value + 1)}><LuRefreshCw /></button></div>}
    {notice && <p role="status" className="notice chat-alert">{notice}</p>}
    <div className="chat-scroll" aria-label="대화 및 문서 검색 결과">
      {loading && <span className="chat-progress" role="status" aria-label="불러오는 중"><LuLoaderCircle className="spin" /></span>}
      {!loading && !messages.length && !retrieval && <div className="chat-empty"><LuSparkles aria-hidden="true" /><p>문서를 찾거나 질문하세요</p></div>}
      {messages.map(item => {
        const evidence = combineEvidence(item.result, item.id === activeAnswer?.id ? retrieval?.evidence : retrievedSources[item.id]);
        return <article key={item.id} className={`chat-message chat-${item.role}`} aria-label={item.role === "user" ? "팀원 질문" : "AI 답변"}>
          <span className="chat-message-icon" aria-hidden="true">{item.role === "user" ? <LuUser /> : <LuSparkles />}</span>
          {["QUEUED", "RUNNING"].includes(item.state) ? <span className="chat-progress" role="status" aria-label="답변 준비 중" title="답변 준비 중"><LuLoaderCircle className="spin" /></span> : item.state === "FAILED" ? <div className="chat-answer-error"><p role="alert" className="error">{errorLabels[item.error_code || ""] || "답변을 완료하지 못했습니다."}</p><div>{onAISettings && <button className="icon-button" aria-label="AI 연결 설정" title="AI 연결 설정" onClick={onAISettings}><LuSettings2 /></button>}{messages.at(-1)?.id === item.id && <button className="icon-button" aria-label="답변 다시 시도" title="답변 다시 시도" disabled={busy} onClick={() => void retry(item.id)}><LuRefreshCw /></button>}</div></div> : item.result?.claims.length ? item.result.claims.map((claim, i) => <p className="chat-claim" key={i}>{claim.text}<span className="citation-buttons">{claim.source_ids.map(ref => <button key={ref} className="citation" aria-label={`${sourceLabel(ref, item.result!.sources)} 근거 보기`} title="근거 보기" onClick={event => {
            const source = item.result!.sources.find(source => source.id === ref); if (!source) return;
            onRevealSources([source]);
            const target = event.currentTarget.closest("article")?.querySelector<HTMLDetailsElement>(`[id="${item.id}-source-${source.chunk_id}"]`);
            if (target) { const list = target.closest<HTMLDetailsElement>('details.chat-sources'); if (list) list.open = true; target.open = true; target.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
          }}>{sourceLabel(ref, item.result!.sources)}</button>)}</span></p>) : <p className="chat-question-text">{item.content}</p>}
          {item.role === "assistant" && evidence && sources(evidence, item.id, item.state !== "COMPLETED", !!item.result?.insufficient && item.result.claims.length > 0)}
        </article>;
      })}
      {retrieval && !activeAnswer && <>{!hasQuestion && <article className="chat-message chat-user" aria-label="현재 질문"><span className="chat-message-icon" aria-hidden="true"><LuUser /></span><p className="chat-question-text">{retrieval.question}</p></article>}<article className="chat-message chat-assistant" aria-label="찾은 문서"><span className="chat-message-icon" aria-hidden="true"><LuSparkles /></span>{busy && <span className="chat-progress" role="status" aria-label="검색 및 답변 준비 중"><LuLoaderCircle className="spin" /></span>}{retrieval.evidence && sources(retrieval.evidence, retrieval.id)}</article></>}
      <div ref={messageEnd} />
    </div>
    <form className="chat-composer" onSubmit={submit}>
      {filtersOpen && <div className="chat-search-settings" id="chat-search-settings"><label>범위<select aria-label="검색 범위" value={scope} disabled={busy} onChange={event => setScope(event.target.value as Scope)}>{Object.entries(scopeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{scope === "as_of" && <label>날짜<input type="date" aria-label="기준 날짜" max={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date())} required value={asOf} disabled={busy} onChange={event => setAsOf(event.target.value)} /></label>}{workspace.role !== "VIEWER" && <button type="button" className="icon-button" aria-label="색인 다시 시도" title="색인 다시 시도" disabled={busy} onClick={() => void reindex()}><LuRefreshCw /></button>}</div>}
      <div className="chat-input-row"><textarea aria-label="문서 질문" placeholder="문서 찾기 또는 질문하기" maxLength={2000} required value={question} disabled={busy || loadingMessages} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="button" className={`icon-button chat-filter-toggle ${filtersOpen || scope !== "auto" ? "active" : ""}`} aria-label="검색 설정" title={`검색 범위: ${scopeLabels[scope]}`} aria-expanded={filtersOpen} aria-controls="chat-search-settings" onClick={() => setFiltersOpen(!filtersOpen)}><LuSlidersHorizontal /></button><button className="primary chat-send" aria-label="질문 보내기" title="보내기" disabled={blocked || !question.trim() || scope === "as_of" && !asOf}>{busy ? <LuLoaderCircle className="spin" /> : <LuSend />}</button></div>
    </form>
  </aside></div>;
}
