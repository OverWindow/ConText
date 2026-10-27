"use client";
import { Background, BackgroundVariant, ReactFlow, type Node, type Edge, type ReactFlowProps } from '@xyflow/react';

/** Shared interaction and appearance; storage and environment actions stay in adapters. */
export function CanvasSurface<N extends Node, E extends Edge = Edge>({ children, ...props }: ReactFlowProps<N, E>) {
  return <ReactFlow<N, E> panOnScroll panOnScrollSpeed={1} zoomOnScroll={false} zoomOnPinch zoomActivationKeyCode={["Meta", "Control"]} deleteKeyCode={null} minZoom={.1} maxZoom={2} elevateNodesOnSelect={false} nodeExtent={[[-100000, -100000], [100000, 100000]]}
    ariaLabelConfig={{ 'controls.ariaLabel': '캔버스 보기 도구', 'handle.ariaLabel': '문서 연결점', 'controls.zoomIn.ariaLabel': '확대', 'controls.zoomOut.ariaLabel': '축소', 'controls.fitView.ariaLabel': '전체 보기' }} {...props}>
    <Background variant={BackgroundVariant.Lines} gap={28} color="var(--grid)" />{children}
  </ReactFlow>;
}
