"use client";
import { useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { Workspace } from '@context/workspace-ui/workspace';
import { browserWorkspaceRepository } from '@/lib/workspace-v2';
import { webAIRepository } from '@/features/writing/web-ai-repository';
import { useApplicationNavigation } from './application';
export function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const repository = useMemo(() => browserWorkspaceRepository(workspaceId), [workspaceId]);
  const app = useApplicationNavigation(workspaceId);
  return <Workspace repository={repository} navigation={app.navigation} aiRepository={webAIRepository} onDelete={app.onDelete} overlays={app.deletion} />;
}
