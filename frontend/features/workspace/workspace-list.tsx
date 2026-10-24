"use client";
import Link from "next/link";
import { BrandLogo } from "@/features/brand/brand-logo";
import { LuPlus, LuArrowUpRight } from "react-icons/lu";
import { SignOut } from "@/features/auth/sign-out";
import { roles } from "@/lib/labels";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, type User, type Workspace } from "@/lib/api";

export function WorkspaceList() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([api<User>("/me"), api<Workspace[]>("/workspaces")])
      .then(([me, items]) => { if (active) { setUser(me); setWorkspaces(items); } })
      .catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [attempt]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const workspace = await api<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      router.push(`/workspaces/${workspace.id}`);
    } catch (err) { setError(err instanceof Error ? err.message : "워크스페이스를 만들지 못했습니다."); setPending(false); }
  }
  return <div className="home-shell"><header className="home-header"><Link href="/workspaces" className="brand" aria-label="ConText 홈"><BrandLogo /></Link><SignOut /></header><section className="home-content">
    <p className="eyebrow">함께하는 문서 공간</p><h1>나의 워크스페이스</h1>
    {user && <p className="muted">{user.display_name || user.email}님, 함께 생각을 연결해 보세요.</p>}
    {error && <div role="alert" className="error">{error} <button className="secondary" onClick={() => { setError(null); setAttempt(attempt + 1); }}>다시 시도</button></div>}
    {workspaces === null && !error && <p role="status">워크스페이스를 불러오는 중…</p>}
    {workspaces?.length === 0 && <section className="empty"><h2>첫 워크스페이스를 만들어 보세요</h2><p className="muted">우리 팀의 문서와 아이디어를 한곳에 모아 보세요.</p></section>}
    {!!workspaces?.length && <ul className="workspace-grid">{workspaces.map(workspace => <li key={workspace.id}>
      <Link className="workspace-card" href={`/workspaces/${workspace.id}`}><span className="badge">{roles[workspace.role]}</span><h2>{workspace.name}</h2><span className="muted">워크스페이스 열기 <LuArrowUpRight /></span></Link>
    </li>)}</ul>}
    <section className="create-panel"><h2>워크스페이스 만들기</h2><form onSubmit={create}>
      <label htmlFor="workspace-name">워크스페이스 이름</label><div className="form-row">
        <input id="workspace-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} placeholder="예: 프로덕트 팀" disabled={pending} />
        <button className="primary" disabled={pending || !name.trim() || workspaces === null}><LuPlus />{pending ? "만드는 중…" : "워크스페이스 만들기"}</button>
      </div></form></section>
  </section></div>;
}
