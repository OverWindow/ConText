"use client";
import { WorkspaceDetail } from './workspace-detail';
import type { Workspace } from '../../lib/api';
/** Snapshot workspaces now use the same editable protocol and shared UI. */
export function CloudWorkspace({ workspace }: { workspace: Workspace }) {
  return <WorkspaceDetail workspaceId={workspace.id} />;
}
