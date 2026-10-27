import type { ReactNode } from 'react';
function readable(value: unknown): ReactNode {
  if (value === null || value === undefined) return '원본 연결이 없거나 삭제된 항목입니다.';
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value) as { blocks?: { text?: string; items?: string[]; rows?: string[][] }[] }; if (Array.isArray(parsed.blocks)) return parsed.blocks.map(block => block.text || block.items?.join('\n') || block.rows?.map(row => row.join(' | ')).join('\n') || '').join('\n\n'); } catch { /* Plain text. */ }
    return value;
  }
  if (typeof value !== 'object') return String(value);
  const item = value as Record<string, unknown>;
  if (item.payload) return readable(item.payload);
  if (item.element) return readable(item.element);
  if (typeof item.content === 'string') return readable(item.content);
  if (item.version) return readable(item.version);
  if (item.blob && typeof item.blob === 'object') { const blob = item.blob as Record<string, unknown>; return `파일 이력 ${String(item.display_number || item.id || '')}\n크기 ${String(blob.size || 0)}바이트\n무결성 ${String(blob.sha256 || '')}`; }
  if ('content_head_id' in item) return `서버에서 선택한 파일 이력: ${String(item.content_head_id || '없음')}\n인용 기준 이력: ${String(item.reference_head_id || '없음')}`;
  if (typeof item.name === 'string') return item.name;
  return JSON.stringify(value, null, 2);
}
export function ConflictContent({ candidate, current }: { candidate: unknown; current: unknown }) {
  return <div className="unified-conflict-sides"><section><h4>보존된 변경</h4><pre>{readable(candidate)}</pre></section><section><h4>현재 공유 내용</h4><pre>{readable(current)}</pre></section></div>;
}
