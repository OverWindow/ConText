"use client";
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { LuPlus } from 'react-icons/lu';
import { ApplicationHomeShell, ApplicationHome } from '@context/workspace-ui/application';
import type { Workspace } from '@/lib/api';
import { workspaceApi } from '@/lib/workspace-v2';
import { useApplicationNavigation } from './application';
export function WorkspaceList() {
  const router = useRouter(), app = useApplicationNavigation();
  const [name, setName] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  async function create(event: FormEvent) {
    event.preventDefault(); if (!name.trim() || pending) return;
    setPending(true); setError('');
    try { const { workspace } = await workspaceApi<{ workspace: Workspace }>('/workspaces', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); router.push(`/workspaces/${workspace.id}`); }
    catch (reason) { setError((reason as Error).message); setPending(false); }
  }
  return <ApplicationHomeShell navigation={app.navigation}>
    <ApplicationHome onSample={() => router.push('/preview')} spaces={app.navigation.spaces} busy={app.loading} primary={app.navigation.primary} secondary={app.navigation.secondary}>
      {(error || app.error) && <p className="notice error" role="alert">{error || app.error}</p>}
      <section className="application-create-panel"><h2>워크스페이스 만들기</h2><form onSubmit={create}><label htmlFor="workspace-name">워크스페이스 이름</label><div className="form-row"><input id="workspace-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} placeholder="예: 프로덕트 팀" disabled={pending} /><button className="primary" disabled={pending || !name.trim() || app.loading}><LuPlus />{pending ? '만드는 중…' : '워크스페이스 만들기'}</button></div></form></section>
    </ApplicationHome>
    {app.deletion}
  </ApplicationHomeShell>;
}
