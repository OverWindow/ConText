"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { LuArrowRight, LuCopy, LuDownload, LuFileOutput, LuLoaderCircle, LuRotateCw, LuX } from "react-icons/lu";
import { api } from "@/lib/api";
import { message } from "@/lib/labels";
import type { DocumentVersion, WorkspaceDocument } from "@/features/documents/api";
import { downloadConversion, type Conversion, type ConversionFormat } from "@/features/documents/conversion-api";
import "./document-conversions.css";

const formats: ConversionFormat[] = ["pdf", "docx", "txt", "md"];
const names = { pdf: "PDF", docx: "DOCX", txt: "TXT", md: "Markdown" };
const symbols = { pdf: "PDF", docx: "W", txt: "TXT", md: "M↓" };

export function DocumentConversions({ document: doc, version, jobs, onConversion, onCopy, dragging, children }: {
  document: WorkspaceDocument; version?: DocumentVersion; jobs: Conversion[];
  onConversion?: (job: Conversion) => void; onCopy?: (document: WorkspaceDocument, versionId: string, requestId: string) => Promise<void>; dragging: boolean; children: ReactNode;
}) {
  const [trayTop, setTrayTop] = useState(0);
  const tray = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [focused, setFocused] = useState(false);
  const [resultsPinned, setResultsPinned] = useState(false);
  const [sourceId, setSourceId] = useState(version?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const hoverExit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequest = useRef<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const panelId = useId();
  const flow = useReactFlow();
  const connecting = useStore(state => state.connection.inProgress);
  const interacting = dragging || connecting;
  const open = !interacting && pinned;
  const launcherVisible = !interacting && (hovered || focused || busy === "copy");
  const source = doc.versions.find(item => item.id === sourceId) || version;
  const completed = jobs.filter(job => job.state === "COMPLETED");
  const resultsVisible = !interacting && (hovered || focused || resultsPinned);
  const completedFormats = [...new Set(completed.map(job => names[job.format]))].join(" · ");
  useEffect(() => {
    if (!resultsVisible || !completed.length) return;
    const frame = requestAnimationFrame(() => {
      const rect = root.current?.getBoundingClientRect();
      const bounds = root.current?.closest(".react-flow")?.getBoundingClientRect();
      const sidebar = root.current?.closest(".workspace-main")?.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
      if (!rect || !bounds) return;
      const viewport = flow.getViewport();
      const left = Math.max(bounds.left + 16, sidebar?.width ? sidebar.right + 12 : 0);
      const overflow = left - (rect.left - 168 * viewport.zoom);
      if (overflow > 1) void flow.setViewport({ ...viewport, x: viewport.x + overflow }, { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 });
    });
    return () => cancelAnimationFrame(frame);
  }, [resultsVisible, completed.length, flow]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (hoverExit.current) clearTimeout(hoverExit.current); }; }, []);
  useEffect(() => {
    if (!pinned && !resultsPinned) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) { setPinned(false); setResultsPinned(false); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pinned, resultsPinned]);

  function alignTray() {
    const rect = root.current?.getBoundingClientRect();
    const bounds = root.current?.closest(".react-flow")?.getBoundingClientRect();
    if (!rect || !bounds || !tray.current) return;
    const zoom = flow.getViewport().zoom;
    const height = tray.current.getBoundingClientRect().height;
    const top = Math.max(bounds.top + 140, Math.min(rect.top, bounds.bottom - 80 - height));
    setTrayTop((top - rect.top) / zoom);
  }

  function reveal() {
    if (!open) alignTray();
    setPinned(true);
    requestAnimationFrame(() => tray.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    const rect = root.current?.getBoundingClientRect();
    const bounds = root.current?.closest(".react-flow")?.getBoundingClientRect();
    if (rect && bounds) {
      const viewport = flow.getViewport();
      const overflow = rect.right + 254 * viewport.zoom - (bounds.right - 20);
      if (overflow > 0) void flow.setViewport({ ...viewport, x: viewport.x - overflow }, { duration: 180 });
    }
  }

  function close() {
    setPinned(false);
    requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
  }

  async function action(versionId: string, format: ConversionFormat, download: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(`${versionId}/${format}`); setError("");
    try {
      if (download) await downloadConversion(versionId, format);
      else {
        const job = await api<Conversion>(`/versions/${versionId}/conversions/${format}`, { method: "POST" });
        // The canvas owns jobs so completion continues to update after this tray closes.
        onConversion?.(job);
      }
    } catch (err) { if (mounted.current) { setError(message(err)); reveal(); } }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  }

  async function createCopy() {
    if (!version || !onCopy || inFlight.current) return;
    inFlight.current = true;
    setBusy("copy"); setCopyError("");
    copyRequest.current ||= crypto.randomUUID();
    try {
      await onCopy(doc, version.id, copyRequest.current);
      copyRequest.current = null;
    } catch (err) { if (mounted.current) setCopyError(message(err)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  }

  return <div ref={root} className={`document-conversions ${open ? "conversion-open" : ""} ${launcherVisible ? "conversion-hint" : ""} ${interacting ? "conversion-interacting" : ""}`}
    onPointerEnter={event => { if (event.pointerType === "mouse" && event.buttons === 0) { if (hoverExit.current) clearTimeout(hoverExit.current); setHovered(true); } }}
    onPointerLeave={() => { if (hoverExit.current) clearTimeout(hoverExit.current); hoverExit.current = setTimeout(() => setHovered(false), 320); }}
    onFocusCapture={event => { if (!event.target.closest(".conversion-results")) { setFocused(event.target.matches(":focus-visible")); } }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onKeyDown={event => { if (event.key === "Escape" && (open || resultsPinned)) { event.stopPropagation(); setResultsPinned(false); if (open) close(); } }}>
    {children}
    {launcherVisible && !open && <div className="document-hover-bridge nodrag nopan" aria-hidden="true" onClick={event => event.stopPropagation()} />}
    <button ref={launcher} className="conversion-toggle nodrag nopan" tabIndex={open ? -1 : 0} aria-hidden={open} aria-label={`${doc.title} 형식 변환`} title="형식 변환" aria-expanded={open} aria-controls={panelId}
      onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (pinned) close(); else reveal(); }}><LuFileOutput /><span className="conversion-toggle-label">형식 변환</span></button>
    {onCopy && <button className="conversion-toggle document-copy-toggle nodrag nopan" tabIndex={open ? -1 : 0} aria-hidden={open} aria-label={`${doc.title} 복사본 생성하기`} disabled={busy !== null || !version || ["PENDING", "UPLOADING"].includes(version.status)} title="현재 수정 이력 복사본 생성하기"
      onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void createCopy(); }}>{busy === "copy" ? <LuLoaderCircle className="spin" /> : <LuCopy />}<span className="conversion-toggle-label">{busy === "copy" ? "복사 중…" : "복사본 생성하기"}</span></button>}
    {copyError && <p className="document-copy-error nodrag nopan" role="alert" onClick={event => event.stopPropagation()}>{copyError}</p>}
    <aside ref={tray} style={{ top: trayTop, "--conversion-origin-y": `${-trayTop}px` } as CSSProperties} id={panelId} className="conversion-tray nodrag nopan nowheel" aria-label={`${doc.title} 형식 변환 패널`} aria-hidden={!open} inert={!open}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}>
      <div className="conversion-tray-heading"><span><LuFileOutput /> 형식 변환</span><button aria-label="형식 변환 닫기" onClick={close}><LuX /></button></div>
      <div className="conversion-tray-body">
      <label className="conversion-source">원본 수정 이력<select aria-label="변환할 원본 수정 이력" value={source?.id || ""} disabled={busy !== null || !source} onChange={event => { setPinned(true); setSourceId(event.target.value); setError(""); }}>
        {[...doc.versions].sort((a, b) => b.version_number - a.version_number).map(item => <option value={item.id} key={item.id}>이력 {item.version_number}{item.id === doc.current_version_id ? " · 현재 수정 이력" : ""}</option>)}
      </select></label>
      <div className="conversion-choices">{formats.map(format => {
        const job = jobs.find(item => item.version_id === source?.id && item.format === format);
        const pending = job?.state === "QUEUED" || job?.state === "RUNNING";
        const done = job?.state === "COMPLETED";
        const failed = job?.state === "FAILED";
        const waiting = pending || busy === `${source?.id}/${format}`;
        return <button key={format} className={`conversion-choice conversion-${format}`} disabled={!source || busy !== null || pending || (!done && source.status !== "READY")}
          aria-label={`${names[format]} ${done ? "다운로드" : failed ? "변환 다시 시도" : "변환"}`} title={job?.error_message || undefined}
          onClick={() => { setPinned(true); if (source) void action(source.id, format, done); }}>
          <span className="conversion-file-glyph" aria-hidden="true">{symbols[format]}</span>
          <span><strong>{names[format]}</strong><small>{waiting ? "변환 중…" : done ? "다운로드" : failed ? "다시 시도" : "변환하기"}</small></span>
          {waiting ? <LuLoaderCircle className="spin" /> : done ? <LuDownload /> : failed ? <LuRotateCw /> : <LuArrowRight />}
        </button>;
      })}</div>
      {source?.status !== "READY" && <p role="status" className="conversion-note">문서 처리 완료 후 변환할 수 있습니다.</p>}
      {jobs.filter(job => job.version_id === source?.id && job.state === "FAILED").map(job => <p className="conversion-error" role="alert" key={job.format}>{names[job.format]}: {job.error_message || "변환에 실패했습니다. 다시 시도해 주세요."}</p>)}
      {error && <p role="alert" className="conversion-error">{error}</p>}
      {jobs.filter(job => job.version_id === source?.id).flatMap(job => (job.warnings || []).filter(warning => !warning.startsWith("텍스트·제목·목록·표")).map(warning => `${names[job.format]}: ${warning}`)).map((warning, index) => <p className="conversion-note" key={index}>{warning}</p>)}
      </div>
    </aside>
    {completed.length > 0 && <button className="conversion-summary nodrag nopan" hidden={resultsVisible || interacting} aria-label={`${doc.title} 변환된 파일 보기: ${completedFormats}`} title={`${completedFormats} 형식 변환 완료`} aria-expanded={resultsVisible} onClick={event => { event.stopPropagation(); setResultsPinned(true); }} onKeyDown={event => event.stopPropagation()}><span>{completedFormats}</span><small>변환됨</small></button>}
    {completed.length > 0 && <div className={`conversion-results nodrag nopan nowheel ${resultsVisible ? "is-visible" : ""}`} aria-hidden={!resultsVisible} inert={!resultsVisible} aria-label={`${doc.title} 변환된 파일`} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}>
      {completed.map(job => {
        const origin = doc.versions.find(item => item.id === job.version_id);
        if (!origin) return null;
        return <div className="conversion-result" key={`${job.version_id}/${job.format}`}>
          <span className="conversion-version-arrow" aria-label={`원본 수정 이력 ${origin.version_number}에서 변환`}><span>이력 {origin.version_number}</span><svg viewBox="0 0 43 16" fill="none" aria-hidden="true"><path d="M1 8H38" stroke="currentColor" strokeDasharray="3 3" /><path d="m33 3 6 5-6 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          <button className={`converted-file conversion-${job.format}`} aria-label={`수정 이력 ${origin.version_number} ${names[job.format]} 파일 다운로드`} title={`${origin.original_filename} → ${names[job.format]} · 다운로드`} disabled={busy !== null} onClick={() => void action(job.version_id, job.format, true)}>
            <span className="conversion-file-glyph" aria-hidden="true">{symbols[job.format]}</span><span>{names[job.format]}</span><LuDownload />
          </button>
        </div>;
      })}
    </div>}
  </div>;
}
