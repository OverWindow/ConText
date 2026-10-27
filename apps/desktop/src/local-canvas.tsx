import { useMemo } from 'react';
import { WorkspaceCanvas, WorkspaceRuntimeProvider, type WorkspaceCanvasProps, type WorkspaceRuntime } from '@context/workspace-ui';
import { LocalFileDerivatives } from './file-derivatives';
export type { CreateCanvasFile } from '@context/workspace-ui';
/** Native shell; all canvas editing behavior lives in the common workspace package. */
export function DesktopCanvas(props: WorkspaceCanvasProps) {
  const runtime = useMemo<WorkspaceRuntime>(() => ({
    ...window.contextDesktop,
    capabilities: { nativeFiles: true, label: '로컬', summarize: true },
    renderFileActions: properties => <LocalFileDerivatives {...properties} />,
  }), []);
  return <WorkspaceRuntimeProvider runtime={runtime}><WorkspaceCanvas {...props} /></WorkspaceRuntimeProvider>;
}
