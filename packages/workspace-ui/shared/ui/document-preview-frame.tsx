"use client";
import { useEffect, useRef, type ReactNode } from 'react';
import './document-preview-frame.css';

export function DocumentPreviewFrame({ children, className = '', onClose, labelledBy = 'preview-title' }: { children: ReactNode; className?: string; onClose: () => void; labelledBy?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={`document-dialog preview-dialog context-document-preview ${className}`} aria-labelledby={labelledBy}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>{children}</dialog>;
}
