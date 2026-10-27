/* eslint-disable @next/next/no-location-assign-relative-destination -- Full navigation clears protected session state. */
"use client";
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LuPlus, LuCloudDownload } from 'react-icons/lu';
import { AccountControl, type AccountRepository } from '@context/workspace-ui/account-control';
import type { AccountState } from '@context/workspace-ui/shared/core/account';
import type { ApplicationNavigation } from '@context/workspace-ui/application';
import { browserSupabase } from '@/lib/supabase/client';
import { workspaceApi } from '@/lib/workspace-v2';
import type { User, Workspace } from '@/lib/api';
import { DeleteWorkspaceDialog } from './delete-workspace-dialog';

const accountRepository: AccountRepository = {
  async accountStatus() {
    const { data, error } = await browserSupabase().auth.getSession();
    const base = { serverBaseUrl: process.env.NEXT_PUBLIC_WORKSPACE_API_URL || 'http://localhost:8001', storageAvailable: true };
    if (error || !data.session) return { ...base, status: 'guest', user: null, message: '로그인이 필요합니다.' };
    const sessionUser = data.session.user;
    try { return { ...base, status: 'signed_in', user: await workspaceApi<User>('/me'), message: '' }; }
    catch (reason) { return { ...base, status: 'offline', user: { id: sessionUser.id, email: sessionUser.email || '', display_name: sessionUser.user_metadata?.display_name || null }, message: (reason as Error).message }; }
  },
  accountRefresh() { return accountRepository.accountStatus(); },
  async accountLogin() { window.location.assign('/login'); return accountRepository.accountStatus(); },
  async accountLogout() { const { error } = await browserSupabase().auth.signOut({ scope: 'local' }); if (error) throw error; window.location.assign('/login'); return accountRepository.accountStatus(); },
  async accountCancelLogin() {},
  onAccountChanged(callback: (state: AccountState) => void) {
    let active = true;
    const { data } = browserSupabase().auth.onAuthStateChange(() => { setTimeout(() => { if (active) void this.accountStatus().then(state => { if (active) callback(state); }); }, 0); });
    return () => { active = false; data.subscription.unsubscribe(); };
  },
};
export function useApplicationNavigation(activeId?: string) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Workspace>();
  useEffect(() => { let active = true; workspaceApi<{ workspaces: Workspace[] }>('/workspaces').then(value => { if (active) setWorkspaces(value.workspaces); }).catch(reason => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const navigation: ApplicationNavigation = useMemo(() => ({
    logo: '/brand/context-logo.png', symbol: '/brand/context-symbol.png', activeId, onHome: () => router.push('/workspaces'), loading,
    spaces: workspaces.map(item => ({ id: item.id, name: item.name, detail: '공유 워크스페이스', kind: 'cloud' as const, onOpen: () => router.push(`/workspaces/${item.id}`), onRemove: item.role === 'OWNER' ? () => setDeleting(item) : undefined })),
    account: <AccountControl repository={accountRepository} />,
    secondary: <button className="secondary cloud-library-button" onClick={() => { if (activeId) router.push('/workspaces'); else (document.querySelector('.application-space-grid') || document.getElementById('workspace-name'))?.scrollIntoView({ block: 'center' }); }}><LuCloudDownload />클라우드 워크스페이스 열기</button>,
    primary: <button className="primary connect" onClick={() => { if (activeId) router.push('/workspaces'); else document.getElementById('workspace-name')?.focus(); }}><LuPlus />새 워크스페이스</button>,
  }), [activeId, router, loading, workspaces]);
  const deletion = deleting && <DeleteWorkspaceDialog key={deleting.id} workspace={deleting} onClose={() => setDeleting(undefined)} onDeleted={() => { setWorkspaces(items => items.filter(item => item.id !== deleting.id)); setDeleting(undefined); if (activeId === deleting.id) router.push('/workspaces'); }} />;
  return { navigation, workspaces, loading, error, deletion, onDelete: workspaces.find(item => item.id === activeId && item.role === 'OWNER') ? () => setDeleting(workspaces.find(item => item.id === activeId)) : undefined };
}
