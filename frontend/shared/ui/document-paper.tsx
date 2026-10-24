import type { ReactNode } from "react";
import { LuAlignLeft, LuArrowDown, LuCheck, LuCircleAlert, LuClock3, LuFile, LuFolder, LuImage, LuLink2, LuLoaderCircle } from "react-icons/lu";
import { PiFilePdfDuotone } from "react-icons/pi";
import "./document-paper.css";

export function fileSize(size?: number) {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Shared presentation only: neither cloud APIs nor native file access belongs here. */
export function DocumentPaper({ kind, name, description, filename, size, state = "READY", status, badge, connections = 0, thumbnail }: {
  kind: string; name: string; description: string; filename: string; size?: number;
  state?: string; status: string; badge?: ReactNode; connections?: number; thumbnail?: string;
}) {
  const StatusIcon = state === "READY" ? LuCheck : state === "FAILED" ? LuCircleAlert : state === "PROCESSING" ? LuLoaderCircle : LuClock3;
  return <>
    <div className="paper-sheet">
      <svg className="paper-outline" viewBox="0 0 200 244" fill="none" aria-hidden="true">
        <path className="paper-face" d="M19 1H150L199 50V225Q199 243 181 243H19Q1 243 1 225V19Q1 1 19 1Z" />
        <path className="paper-fold" d="M150 1V36Q150 50 164 50H199Z" />
      </svg>
      <span className="canvas-file-kind">{name}<span className="visually-hidden"> · {description}</span></span>
      <span className={`paper-status-dot status-${state}`} title={status} aria-hidden="true" />
      <div className="paper-caption"><strong title={filename}>{filename}</strong></div>
      <div className={`paper-glyph ${thumbnail ? "paper-glyph-image" : ""}`} aria-hidden="true">
        {/* Both applications provide a bounded, trusted preview URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : kind === "folder" ? <LuFolder /> : kind === "image" ? <LuImage /> : kind === "pdf" ? <PiFilePdfDuotone /> : kind === "docx" ? <span className="paper-word">W</span> : kind === "hwpx" ? <span className="paper-hangul">한</span> : kind === "md" ? <span className="paper-markdown">M<LuArrowDown /></span> : <LuAlignLeft />}
      </div>
      <div className="paper-metadata"><span className="paper-size"><LuFile aria-hidden="true" />{fileSize(size)}</span>{badge}</div>
      <div className="paper-bottom"><span className={`canvas-file-status status-${state}`}><StatusIcon aria-hidden="true" className={state === "PROCESSING" ? "spin" : undefined} />{status}</span>{connections > 0 && <span className="paper-connections" title={`연결된 문서 ${connections}개`} aria-label={`연결 ${connections}개`}><LuLink2 aria-hidden="true" />{connections}</span>}</div>
    </div>
  </>;
}
