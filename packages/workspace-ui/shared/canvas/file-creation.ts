type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };

/** A selection belongs to its deepest shared physical folder, regardless of camera focus. */
export function creationDirectory(entries: { parent_path: string }[]) {
  const parts = entries[0]?.parent_path.split('/').filter(Boolean) || [];
  for (const entry of entries.slice(1)) {
    const next = entry.parent_path.split('/');
    while (parts.some((part, index) => next[index] !== part)) parts.pop();
  }
  return parts.join('/');
}

/** Copies and summaries inherit the source's logical folder, even when placed near its edge. */
export function sharedFolder(ids: string[], owners: Map<string, string>): string | null {
  const ancestors = (id: string) => {
    const result: string[] = [];
    let owner = owners.get(id);
    while (owner && !result.includes(owner)) { result.push(owner); owner = owners.get(owner); }
    return result;
  };
  const chains = ids.map(ancestors);
  return chains[0]?.find(id => chains.every(chain => chain.includes(id))) || null;
}

/** Generated connections leave the side facing the other card, including vertical arrangements. */
export function facingHandles(source: Bounds, target: Bounds, obstacles: Bounds[] = []) {
  const dx = target.x + target.width / 2 - source.x - source.width / 2;
  const dy = target.y + target.height / 2 - source.y - source.height / 2;
  const horizontal = Math.abs(dx) / (source.width + target.width) >= Math.abs(dy) / (source.height + target.height);
  const sx = source.x + source.width / 2, tx = target.x + target.width / 2, sy = source.y + source.height / 2, ty = target.y + target.height / 2;
  const blocking = obstacles.filter(box => box.x < Math.max(sx, tx) + 12 && box.x + box.width > Math.min(sx, tx) - 12 && box.y < Math.max(sy, ty) + 12 && box.y + box.height > Math.min(sy, ty) - 12);
  if (blocking.length) {
    const boxes = [source, target, ...blocking];
    if (horizontal) {
      const top = Math.min(source.y, target.y) - Math.min(...boxes.map(box => box.y));
      const bottom = Math.max(...boxes.map(box => box.y + box.height)) - Math.max(source.y + source.height, target.y + target.height);
      const side = top <= bottom ? 'top' : 'bottom';
      return { sourceHandle: side, targetHandle: side, offset: Math.min(top, bottom) + 48 };
    }
    const left = Math.min(source.x, target.x) - Math.min(...boxes.map(box => box.x));
    const right = Math.max(...boxes.map(box => box.x + box.width)) - Math.max(source.x + source.width, target.x + target.width);
    const side = left <= right ? 'left' : 'right';
    return { sourceHandle: side, targetHandle: side, offset: Math.min(left, right) + 48 };
  }
  return horizontal
    ? { sourceHandle: dx >= 0 ? 'right' : 'left', targetHandle: dx >= 0 ? 'left' : 'right' }
    : { sourceHandle: dy >= 0 ? 'bottom' : 'top', targetHandle: dy >= 0 ? 'top' : 'bottom' };
}
