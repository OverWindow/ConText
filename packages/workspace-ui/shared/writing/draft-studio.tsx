"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LuArrowUp, LuCheck, LuDownload, LuFilePenLine, LuPlus, LuSave, LuTrash2, LuUndo2, LuX } from "react-icons/lu";
import { BlockEditor, type EditorHandle } from "./block-editor";
import { blockText, type WritingDraft, type DraftRepository, type ExportFormat } from "./types";
import "./writing.css";

export function DraftStudio({ workspace, repository, onClose, initialDraftId, onAISettings, exportFormats = ['docx', 'hwpx'] }: { workspace: { id: string; name: string; role: "OWNER" | "EDITOR" | "VIEWER" }; repository: DraftRepository; onClose: () => void; initialDraftId?: string; onAISettings?: () => void; exportFormats?: ExportFormat[] }) {
  const [drafts, setDrafts] = useState<{ id: string; title: string }[]>([]);
  const [draft, setDraft] = useState<WritingDraft | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [discard, setDiscard] = useState<null | (() => void)>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const draftIdentity = useRef('');
  draftIdentity.current = draft ? `${draft.id}:${draft.revision}` : '';
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const mounted = useRef(true);
  const editable = workspace.role !== "VIEWER";
  const refresh = useCallback(async () => setDrafts(await repository.list()), [repository]);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void repository.list().then(items => {
      if (mounted.current) setDrafts(items);
      if (initialDraftId) return repository.get(initialDraftId).then(value => { if (mounted.current) adopt(value); });
    }).catch((e: Error) => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; };
  }, [repository, initialDraftId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function adopt(value: WritingDraft) {
    setDraft(value); setTitle(value.title); setDirty(false); setSelected("");
  }
  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "작업에 실패했습니다."); }
    finally { if (mounted.current) setBusy(""); }
  }
  function navigate(action: () => void) {
    if (busy) return;
    if (dirty) setDiscard(() => action); else action();
  }
  async function save(): Promise<WritingDraft> {
    if (!draft) throw new Error("작성할 문서를 먼저 열어 주세요.");
    if (!dirty) return draft;
    const blocks = await editor.current?.read();
    if (!blocks?.length) throw new Error("문서에 내용을 입력해 주세요.");
    const value = await repository.save(draft.id, draft.revision, { title: title.trim(), blocks });
    adopt(value);
    await refresh();
    return value;
  }
  async function write() {
    if (!prompt.trim()) return;
    await run("관련 자료를 찾아 원문을 확인하고 문서를 작성하고 있습니다…", async () => {
      const current = draft ? await save() : null;
      const key = `${current?.id || "new"}:${prompt}`;
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const value = await repository.generate({ draftId: current?.id, revision: current?.revision, prompt, requestId: request.current.id });
      adopt(value); setPrompt(""); request.current = null; await refresh();
    });
  }
  async function review(action: "accept" | "reject" | "undo") {
    if (!draft) return;
    await run("문서에 반영하고 있습니다…", async () => {
      const value = await repository.review(draft.id, draft.revision, action);
      adopt(value); await refresh();
    });
  }
  async function deleteDraft() {
    if (!draft || !editable) return;
    setConfirmDelete(false);
    await run("문서를 삭제하고 있습니다…", async () => {
      await repository.remove(draft.id, draft.revision);
      setDrafts(items => items.filter(item => item.id !== draft.id));
      setDraft(null); setTitle(""); setPrompt(""); setDirty(false); setSelected("");
      request.current = null;
    });
  }
  async function download(format: ExportFormat) {
    await run(`${format.toUpperCase()} 파일을 만들고 있습니다…`, async () => {
      const current = await save();
      await repository.export(current.id, current.revision, format);
    });
  }
  const selectedBlock = draft?.content.blocks.find(b => b.id === selected);
  const used = new Set((selectedBlock ? [selectedBlock] : draft?.content.blocks || []).flatMap(b => b.source_ids));
  const sources = draft?.sources.filter(s => used.has(s.id)) || [];
  function editorChanged() {
    // Editor.js may report mutations while restoring saved blocks. Only user content changes are dirty.
    const current = editor.current, original = draft;
    if (!current || !original) return;
    const identity = `${original.id}:${original.revision}`;
    void current.read().then(blocks => {
      if (draftIdentity.current !== identity) return;
      if (!blocks.length && original.content.blocks.every(block => block.type === 'paragraph' && !block.text.trim())) return;
      if (JSON.stringify(blocks) !== JSON.stringify(original.content.blocks)) setDirty(true);
    }).catch(() => {});
  }
  return <dialog ref={dialog} className="writing-studio" aria-label="AI 문서 작성" onCancel={event => { event.preventDefault(); if (!busy) navigate(onClose); }}>
    <header className="writing-topbar">
      <div><LuFilePenLine /><strong>AI 문서 작성</strong><span>{workspace.name}</span></div>
      {onAISettings && <button disabled={!!busy} onClick={onAISettings}>AI 연결</button>}
      <button className="icon-button" aria-label="문서 작성 닫기" disabled={!!busy} onClick={() => navigate(onClose)}><LuX /></button>
    </header>
    <div className="writing-layout">
      <aside className="writing-library" aria-label="작성한 문서">
        <button className="writing-new" disabled={!!busy || !editable} onClick={() => navigate(() => { setDraft(null); setTitle(""); setPrompt(""); setError(""); setDirty(false); setSelected(""); request.current = null; })}><LuPlus /> 새 문서</button>
        <p>저장한 문서</p>
        {drafts.map(item => <button key={item.id} className={draft?.id === item.id ? "selected" : ""} disabled={!!busy} onClick={() => navigate(() => void run("문서를 불러오는 중…", async () => { adopt(await repository.get(item.id)); setPrompt(""); }))}>{item.title}</button>)}
        {!drafts.length && <small>작성한 문서가 여기에 저장됩니다.</small>}
      </aside>
      <main className="writing-main">
        {error && <div role="alert" className="writing-error">{error}{draft && <button disabled={!!busy} onClick={() => navigate(() => void run("문서를 불러오는 중…", async () => adopt(await repository.get(draft.id))))}>저장된 문서 다시 열기</button>}{request.current && <><p>이전 AI 요청의 처리 여부가 불확실하면 새 요청에 크레딧이 추가로 사용될 수 있습니다.</p><button disabled={!!busy} onClick={() => { request.current = null; setError('다음 작성 시 새 요청으로 보냅니다.'); }}>새 요청으로 다시 시도 준비</button></>}</div>}
        {draft ? <>
          <div className="writing-actions">
            <span aria-live="polite">{dirty ? "저장하지 않은 변경" : `저장됨 · 버전 ${draft.revision}`}</span>
            <button disabled={!!busy || !dirty || !editable} onClick={() => void run("저장 중…", async () => { await save(); })}><LuSave /> 저장</button>
            <button disabled={!!busy || dirty || !draft.can_undo || !editable} onClick={() => void review("undo")}><LuUndo2 /> 되돌리기</button>
            {exportFormats.map(format => <button key={format} disabled={!!busy} onClick={() => void download(format)}><LuDownload /> {format.toUpperCase()}</button>)}
            {editable && <button className="writing-delete-button" disabled={!!busy} onClick={() => setConfirmDelete(true)}><LuTrash2 /> 문서 삭제</button>}
          </div>
          {draft.proposal && <section className="writing-review" aria-label="AI 수정안 검토">
            <h3>수정안을 확인해 주세요</h3>
            <p>현재 문서는 아직 바뀌지 않았습니다. 적용 후에도 되돌릴 수 있습니다.</p>
            <div className="writing-comparison"><div><h4>현재 문서</h4><strong>{draft.content.title}</strong>{draft.content.blocks.map(b => <p key={b.id}>{blockText(b)}</p>)}</div><div><h4>수정안</h4><strong>{draft.proposal.content.title}</strong>{draft.proposal.content.blocks.map(b => <p key={b.id}>{blockText(b)}</p>)}</div></div>
            <details className="writing-proposal-sources"><summary>수정안에서 참고한 원문</summary>{draft.proposal.sources.filter(s => draft.proposal!.content.blocks.some(b => b.source_ids.includes(s.id))).map(s => <div key={s.id}><strong>{s.document_title}</strong><p>{s.text}</p></div>)}</details>
            {draft.proposal.checks.map((c, i) => <small key={i}>{c}</small>)}
            <button disabled={!!busy || !editable} onClick={() => void review("accept")}><LuCheck /> 수정안 적용</button>
            <button disabled={!!busy || !editable} onClick={() => void review("reject")}>수정안 버리기</button>
          </section>}
          <div className="writing-paper" inert={!!busy || !!draft.proposal}>
            <input aria-label="문서 제목" value={title} readOnly={!editable} maxLength={200} onChange={e => { setTitle(e.target.value); setDirty(true); }} />
            <BlockEditor key={`${draft.id}:${draft.revision}`} ref={editor} blocks={draft.content.blocks} readOnly={!editable} onDirty={editorChanged} onSelect={setSelected} />
          </div>
        </> : <div className="writing-empty"><LuFilePenLine /><h2>자료에서, 완성된 문서로.</h2><p>무엇을 만들고 싶은지만 알려주세요.<br />이 워크스페이스의 문서·메모·대화를 찾아 초안을 작성합니다.</p><button className="writing-manual" disabled={!editable || !!busy} onClick={() => void run("새 문서를 만들고 있습니다…", async () => { adopt(await repository.create(crypto.randomUUID())); await refresh(); })}><LuPlus /> 직접 작성하기</button><div>{["관련 자료로 프로젝트 소개서를 작성해줘", "최근 회의 내용을 정리해서 활동계획서를 작성해줘", "자료를 비교해 핵심 내용을 보고서로 작성해줘"].map(s => <button disabled={!editable || !!busy} key={s} onClick={() => setPrompt(s)}>{s}</button>)}</div></div>}
      </main>
      <aside className="writing-context" aria-label="작성 근거">
        <h3>{selectedBlock ? "선택한 문단의 출처" : "문서의 출처"}</h3>
        {selectedBlock && <button onClick={() => setSelected("")}>전체 출처 보기</button>}
        <p className="writing-muted">문단을 클릭하면 참고한 원문을 볼 수 있습니다.</p>
        {sources.map(s => <details key={s.id}><summary>{s.document_title}{s.version_number && <small>v{s.version_number}{s.is_current === false ? " · 과거 자료" : ""}</small>}</summary><p>{s.text}</p>{s.updated_at && <small>{new Date(s.updated_at).toLocaleString("ko-KR")}</small>}</details>)}
        {draft && !sources.length && <p>연결된 출처가 없습니다. 내용을 직접 확인해 주세요.</p>}
        {!!draft?.checks.length && <section className="writing-checks"><h3>확인할 내용</h3>{draft.checks.map((check, i) => <p key={i}>{check}</p>)}</section>}
        {dirty && <p className="writing-checks">직접 수정한 내용은 연결된 출처와 다시 대조해 주세요.</p>}
        <small>내보내기는 제목·본문·목록·표를 지원합니다. 제출 전 한글·Word에서 쪽 배치를 확인해 주세요.</small>
      </aside>
    </div>
    <footer className="writing-composer">
      {busy && <p role="status">{busy}</p>}
      {!editable ? <p>보기 권한입니다. 저장된 문서와 출처를 읽고 파일을 다운로드할 수 있습니다.</p> : <form onSubmit={e => { e.preventDefault(); void write(); }}>
        <label htmlFor="writing-prompt">{draft ? "이 문서를 어떻게 수정할까요?" : "어떤 문서를 만들까요?"}</label>
        <div><textarea id="writing-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={draft ? "예산 내용을 표로 정리하고 추진 배경을 보강해줘" : "관련 자료를 찾아 대회 제출용 프로젝트 소개서를 작성해줘"} maxLength={4000} disabled={!!busy || !!draft?.proposal} rows={2} /><button aria-label={draft ? "AI 수정안 만들기" : "AI 초안 만들기"} disabled={!!busy || !prompt.trim() || !!draft?.proposal}><LuArrowUp /></button></div>
        <small>현재 워크스페이스에서 자동 검색 · 새 초안은 저장, 기존 문서는 수정안 검토 후 적용</small>
      </form>}
    </footer>
    {confirmDelete && draft && <DeleteDraftDialog title={draft.title} dirty={dirty} onCancel={() => setConfirmDelete(false)} onConfirm={() => void deleteDraft()} />}
    {discard && <div className="writing-discard" role="alertdialog" aria-label="저장하지 않은 변경"><p>저장하지 않은 변경이 있습니다.</p><button onClick={() => { const action = discard; setDiscard(null); action(); }}>변경 버리고 이동</button><button onClick={() => setDiscard(null)}>계속 편집</button></div>}
  </dialog>;
}

function DeleteDraftDialog({ title, dirty, onCancel, onConfirm }: { title: string; dirty: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="writing-delete-confirm" role="alertdialog" aria-labelledby="writing-delete-title" aria-describedby="writing-delete-description" onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}>
    <h2 id="writing-delete-title">문서를 삭제할까요?</h2>
    <p className="writing-delete-name">{title}</p>
    <p id="writing-delete-description">이 문서의 본문·수정안·저장 이력이 함께 삭제됩니다. 삭제 후에는 되돌릴 수 없습니다.</p>
    {dirty && <p>저장하지 않은 변경도 함께 버립니다.</p>}
    <div><button autoFocus className="secondary" onClick={onCancel}>취소</button><button className="primary writing-delete-button" onClick={onConfirm}>삭제하기</button></div>
  </dialog>;
}
