import { Handle, Position } from '@xyflow/react';

export function DocumentHandles({ isConnectable }: { isConnectable: boolean }) {
  return <>{([[Position.Left, '왼쪽'], [Position.Right, '오른쪽'], [Position.Top, '위쪽'], [Position.Bottom, '아래쪽']] as const).map(([position, label]) =>
    <Handle key={position} id={position} type="source" position={position} aria-label={`${label} 연결점`} title={`${label} 연결점`} isConnectable={isConnectable} style={{ visibility: isConnectable ? 'visible' : 'hidden' }} />
  )}</>;
}
