import { useState } from 'react';
import { LuFolderOpen, LuPencil, LuTrash2, LuUnplug } from 'react-icons/lu';
import type { Entry } from './contracts';

export function FileActions({ entry, onDeleted }: { entry: Entry; onDeleted: () => void }) {
  const [renaming, setRenaming] = useState(false), [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await action(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <section className="local-file-actions" aria-label="원본 파일 작업">{error && <p role="alert" className="error">{error}</p>}
    <div><button className="icon-button" aria-label="이름 변경" title="이름 변경" disabled={busy} onClick={() => { setName(entry.name); setRenaming(!renaming); }}><LuPencil /></button><button className="icon-button" aria-label="파일 이동" title="파일 이동" disabled={busy} onClick={() => void run(() => window.contextDesktop.moveFile(entry.workspace_id, entry.id))}><LuFolderOpen /></button><button className="icon-button" aria-label="파일 연결 해제" title="연결 해제 · 원본 유지" disabled={busy} onClick={() => void run(async () => { await window.contextDesktop.disconnectFile(entry.workspace_id, entry.id); onDeleted(); })}><LuUnplug /></button><button className="icon-button danger" aria-label="휴지통으로 이동" title="휴지통으로 이동" disabled={busy} onClick={() => void run(async () => { if (await window.contextDesktop.trashFile(entry.workspace_id, entry.id)) onDeleted(); })}><LuTrash2 /></button></div>
    {renaming && <form onSubmit={event => { event.preventDefault(); void run(async () => { await window.contextDesktop.renameFile(entry.workspace_id, entry.id, name); setRenaming(false); }); }}><label>새 파일 이름<input aria-label="새 파일 이름" value={name} maxLength={240} required onChange={event => setName(event.target.value)} /></label><button disabled={busy}>이름 저장</button><button type="button" disabled={busy} onClick={() => setRenaming(false)}>취소</button></form>}
  </section>;
}
