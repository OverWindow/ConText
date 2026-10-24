"use client";

import { useEffect, useRef, useState } from "react";
import { LuDownload, LuFileOutput, LuRefreshCw } from "react-icons/lu";
import { api } from "@/lib/api";
import { message } from "@/lib/labels";
import type { DocumentVersion } from "./api";

import type { Conversion, ConversionFormat as Format } from "./conversion-api";

const formats: { id: Format; name: string; description: string }[] = [
  { id: "pdf", name: "PDF", description: "한글 글꼴을 포함한 읽기·공유용 문서" },
  { id: "docx", name: "Word (DOCX)", description: "제목·목록·표를 편집할 수 있는 문서" },
  { id: "txt", name: "텍스트 (TXT)", description: "본문 전체를 UTF-8 텍스트로 저장" },
  { id: "md", name: "Markdown", description: "제목·목록·표·코드를 마크다운으로 저장" },
];
const states = { QUEUED: "변환 대기 중", RUNNING: "변환 중", COMPLETED: "다운로드 준비 완료", FAILED: "변환 실패" };

export function DocumentExport({ version }: { version: DocumentVersion }) {
  const [jobs, setJobs] = useState<Conversion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Format | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  const mounted = useRef(true);
  const prefix = `/versions/${version.id}/conversions`;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!actionInFlight.current) {
        const request = ++generation.current;
        try {
          const result = await api<Conversion[]>(prefix);
          if (active && request === generation.current) { setJobs(result); setLoaded(true); setError(""); }
        } catch (err) {
          if (active && request === generation.current) setError(message(err));
        }
      }
      if (active) timer = setTimeout(() => void load(), 2500);
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [prefix, revision]);

  async function action(format: Format, download: boolean) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    ++generation.current;
    setBusy(format); setError("");
    try {
      if (download) {
        const result = await api<{ download_url: string }>(`${prefix}/${format}/download-url`, { method: "POST" });
        if (!mounted.current) return;
        const link = document.createElement("a");
        link.href = result.download_url;
        link.rel = "noopener noreferrer";
        link.referrerPolicy = "no-referrer";
        document.body.appendChild(link); link.click(); link.remove();
      } else {
        const job = await api<Conversion>(`${prefix}/${format}`, { method: "POST" });
        if (mounted.current) setJobs(previous => [...previous.filter(item => item.format !== format), job]);
      }
    } catch (err) { if (mounted.current) setError(message(err)); }
    finally { actionInFlight.current = false; if (mounted.current) setBusy(null); }
  }

  return <section className="document-export" aria-label={`수정 이력 ${version.version_number} 내보내기`}>
    <div className="export-heading"><LuFileOutput /><div><h3>다른 형식으로 내보내기</h3><p>수정 이력 {version.version_number} · {version.original_filename}</p></div></div>
    <p className="notice">텍스트·제목·목록·표 중심으로 변환합니다. 이미지, 원본 배치와 복잡한 서식은 포함되지 않습니다. 원본 파일과 수정 이력은 그대로 유지됩니다.</p>
    {version.status !== "READY" && <p role="status" className="notice">문서 처리가 완료되면 변환을 시작할 수 있습니다.</p>}
    {error && <div role="alert" className="error">{error} <button className="secondary" onClick={() => setRevision(value => value + 1)}><LuRefreshCw /> 상태 다시 확인</button></div>}
    {!loaded && !error && <p role="status">변환 기록을 불러오는 중…</p>}
    <div className="export-formats">{formats.map(format => {
      const job = jobs.find(item => item.format === format.id);
      const pending = job?.state === "QUEUED" || job?.state === "RUNNING";
      const completed = job?.state === "COMPLETED";
      return <article key={format.id} className="export-format" aria-label={format.name}>
        <h4>{format.name}</h4><p>{format.description}</p>
        <p role="status" className={`export-status ${job?.state === "FAILED" ? "error" : ""}`}>{job ? states[job.state] : "변환 전"}{completed && job.size !== null && ` · ${Math.max(1, Math.ceil(job.size / 1024))} KB`}</p>
        {job?.error_message && <p className={job.state === "FAILED" ? "error" : "muted"}>{job.error_message}</p>}
        {job?.warnings?.filter(warning => !warning.startsWith("텍스트·제목·목록·표")).map((warning, index) => <p className="notice" key={index}>{warning}</p>)}
        <button className={completed ? "primary" : "secondary"} disabled={!loaded || busy !== null || pending || (!completed && version.status !== "READY")} onClick={() => void action(format.id, completed)} aria-label={`${format.name} ${completed ? "다운로드" : job?.state === "FAILED" ? "변환 다시 시도" : "변환"}`}>
          {completed ? <LuDownload /> : <LuFileOutput />}{busy === format.id ? "요청 중…" : completed ? "다운로드" : pending ? states[job.state] : job?.state === "FAILED" ? "다시 시도" : "변환하기"}
        </button>
      </article>;
    })}</div>
    <p className="muted export-help">변환은 창을 닫아도 계속 진행됩니다. 완료된 파일은 이 수정 이력의 내보내기 탭에서 다시 받을 수 있습니다.</p>
  </section>;
}
