"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Workspace } from "@/lib/api";
import { WorkspaceCanvas } from "@/features/canvas/workspace-canvas";


export function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}`)
      .then(item => { if (active) setWorkspace(item); })
      .catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [workspaceId]);
  return error ? <main className="center-state"><p role="alert" className="error">{error}</p><Link href="/workspaces">워크스페이스 목록으로</Link></main> : !workspace ? <main className="center-state" role="status">워크스페이스를 불러오는 중…</main> : <WorkspaceCanvas key={workspace.id} workspace={workspace} revision={0} />;
}
