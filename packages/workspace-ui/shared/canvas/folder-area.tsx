import { NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import { CanvasDecoration, type ElementNode } from './canvas-elements';
import type { FolderTreeEntry as Entry } from '../core/folder-tree';

export type FolderAreaNode = Node<ElementNode['data'] & { entry: Entry; open: () => void; dropTarget?: boolean; frame: { width: number; height: number; fontScale?: number } }, 'directory'>;

export function FolderArea(props: NodeProps<FolderAreaNode>) {
  const { entry, frame, folder } = props.data;
  return <div className={`local-folder-area ${props.draggable ? 'is-movable' : ''} ${props.data.dropTarget ? 'is-file-drop-target' : ''}`} data-testid={`folder-area-${props.data.entry.name}`}>
    <CanvasDecoration {...props} data={{ ...props.data, editable: false }} type="decoration" hideLabel />
    {folder?.overview && <button type="button" className={`local-folder-overview${props.data.editable ? '' : ' nodrag nopan'}`} style={{ width: frame.width, height: frame.height, padding: 24 * (frame.fontScale || 1), gap: 12 * (frame.fontScale || 1) }} aria-label={`${entry.name} 폴더 펼치기`} onClick={event => { event.stopPropagation(); props.data.open(); }}>
      <strong style={{ fontSize: 36 * (frame.fontScale || 1), lineHeight: `${48 * (frame.fontScale || 1)}px` }}>{entry.name}</strong>
    </button>}
    <NodeToolbar position={Position.Top} offset={-42} isVisible={!props.data.folder?.overview} style={{ zIndex: 40 }}>
      <span className="local-folder-heading">{entry.name}{entry.excluded ? ' · 내용 제외됨' : ''}</span>
    </NodeToolbar>
  </div>;
}
