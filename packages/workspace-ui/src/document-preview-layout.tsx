"use client";
import type { ReactNode } from 'react';
import { LuBookOpen, LuDownload, LuGitCompareArrows, LuHistory, LuX } from 'react-icons/lu';
import { DocumentPreviewFrame } from '../shared/ui/document-preview-frame';
export type DocumentPreviewTab = 'preview' | 'history' | 'compare' | 'export';
export function DocumentPreviewLayout({ name, extension, detail, tab, onTab, versionCount, canCompare, onClose, actions, footer, children }: {
  name: string; extension: string; detail: string; tab: DocumentPreviewTab; onTab: (value: DocumentPreviewTab) => void; versionCount: number; canCompare: boolean; onClose: () => void; actions?: ReactNode; footer: ReactNode; children: ReactNode;
}) {
  return <DocumentPreviewFrame className={`${tab === 'compare' ? 'compare-dialog' : ''} file-theme-${extension.replace(/^\./, '')}`} onClose={onClose}>
    <div className="preview-heading"><LuBookOpen /><div><p className="eyebrow">{extension.replace(/^\./, '').toUpperCase()} · 텍스트 미리보기</p><h2 id="preview-title">{name}</h2><p className="muted">{detail}</p></div><button className="icon-button" aria-label="미리보기 닫기" onClick={onClose}><LuX /></button></div>
    <nav className="preview-tabs" aria-label="문서 수정 이력 메뉴"><button aria-pressed={tab === 'preview'} onClick={() => onTab('preview')}><LuBookOpen />미리보기</button><button aria-label="수정 이력" aria-pressed={tab === 'history'} onClick={() => onTab('history')}><LuHistory />수정 이력 {versionCount}</button><button disabled={!canCompare} aria-pressed={tab === 'compare'} onClick={() => onTab('compare')}><LuGitCompareArrows />수정 이력 비교</button><button aria-pressed={tab === 'export'} onClick={() => onTab('export')}><LuDownload />내보내기</button></nav>
    {actions}{children}<footer className="preview-footer">{footer}</footer>
  </DocumentPreviewFrame>;
}
