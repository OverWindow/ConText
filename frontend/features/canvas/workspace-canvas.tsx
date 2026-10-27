"use client";
import { WorkspaceDetail } from '../workspace/workspace-detail';
import type { Workspace } from '../../lib/api';
/** Compatibility import; the web has one desktop-based workspace implementation. */
export function WorkspaceCanvas({ workspace }: { workspace: Workspace; revision?: number }) {
  return <WorkspaceDetail workspaceId={workspace.id} />;
}
