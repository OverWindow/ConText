import type { NormalizedBlock } from '../core/documents';

export function DocumentBlocks({ blocks, initialBlockId }: { blocks: NormalizedBlock[]; initialBlockId?: number }) {
  return <>{blocks.map(block => <article className={`text-block block-${block.type} ${block.id === initialBlockId ? 'cited-block' : ''}`} key={block.id}>
    {block.source.page && <small>{block.source.page}페이지</small>}
    {block.source.section && <small>구역 {Number(block.source.section.match(/section(\d+)/)?.[1] || 0) + 1} · 문단 {block.source.element}</small>}
    {block.type === 'heading' ? <h4>{block.text}</h4> : block.type === 'table' && block.rows ? <div className="table-scroll"><table><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div> : block.type === 'code' ? <pre>{block.text}</pre> : <p>{block.type === 'list_item' ? '• ' : ''}{block.text}</p>}
  </article>)}</>;
}
