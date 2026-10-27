"use client";
import type { CSSProperties, ReactNode } from 'react';
import { Controls, type FitViewOptions } from '@xyflow/react';

/** One centred row; editing extends the viewing controls to the right. */
export function CanvasDock({ children, host, fitViewOptions, sidebar = 0 }: { children?: ReactNode; host: (element: HTMLDivElement | null) => void; fitViewOptions?: FitViewOptions; sidebar?: number }) {
  return <div className="canvas-dock-shell" style={{ '--dock-sidebar': `${sidebar}px` } as CSSProperties}>
    <div className="canvas-dock" role="toolbar" aria-label="캔버스 도구">
      <Controls showInteractive={false} position="bottom-center" fitViewOptions={fitViewOptions}>{children}</Controls>
      <div className="canvas-dock-edit" ref={host} />
    </div>
  </div>;
}
