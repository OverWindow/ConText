export type PlacementBox = { id: string; x: number; y: number; width: number; height: number };
export type PlacementShift = { id: string; before: { x: number; y: number }; after: { x: number; y: number } };
const GAP = 24, MAX_SHIFT = 160, MAX_AFFECTED = 8;
const overlaps = (a: Omit<PlacementBox, 'id'>, b: PlacementBox) => a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;

/** A local insertion never changes an existing item's row or rebuilds the scene. */
export function planInsertion(incoming: PlacementBox, siblings: PlacementBox[], push = true, bounds?: Omit<PlacementBox, 'id'>) {
  const fits = (box: Omit<PlacementBox, 'id'>) => !bounds || box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width && box.y + box.height <= bounds.y + bounds.height;
  const others = siblings.filter(item => item.id !== incoming.id);
  const row = others.filter(item => incoming.y < item.y + item.height + GAP && incoming.y + incoming.height + GAP > item.y).sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  let best: PlacementShift[] | undefined, cost = Infinity;
  for (let split = 0; split <= row.length; split++) {
    const shifts: PlacementShift[] = [];
    let edge = incoming.x - GAP;
    for (let i = split - 1; i >= 0; i--) {
      const item = row[i], x = Math.min(item.x, edge - item.width);
      if (x === item.x) break;
      if (x !== item.x) shifts.push({ id: item.id, before: { x: item.x, y: item.y }, after: { x, y: item.y } });
      edge = x - GAP;
    }
    edge = incoming.x + incoming.width + GAP;
    for (let i = split; i < row.length; i++) {
      const item = row[i], x = Math.max(item.x, edge);
      if (x === item.x) break;
      if (x !== item.x) shifts.push({ id: item.id, before: { x: item.x, y: item.y }, after: { x, y: item.y } });
      edge = x + item.width + GAP;
    }
    if ((!push && shifts.length > 0) || shifts.length > MAX_AFFECTED || shifts.some(item => Math.abs(item.after.x - item.before.x) > MAX_SHIFT || Math.abs(item.after.x) > 99000)) continue;
    const shifted = others.map(item => ({ ...item, ...(shifts.find(shift => shift.id === item.id)?.after || {}) }));
    if (!fits(incoming) || shifted.some(item => shifts.some(shift => shift.id === item.id) && !fits(item)) || shifted.some(item => overlaps(incoming, item)) || shifts.some(shift => {
      const original = others.find(item => item.id === shift.id)!;
      const moved = shifted.find(item => item.id === shift.id)!;
      return shifted.some(other => other.id !== moved.id && overlaps(moved, other) && !overlaps(original, others.find(item => item.id === other.id)!));
    })) continue;
    const score = shifts.reduce((sum, item) => sum + Math.abs(item.after.x - item.before.x), 0);
    if (score < cost) { best = shifts; cost = score; }
  }
  if (best) return { position: { x: incoming.x, y: incoming.y }, shifts: best, fallback: false };
  // A crowded row moves only the new item. Consider nearby horizontal and vertical
  // gaps without ever sweeping existing nodes into distant rows.
  const candidates = [{ x: incoming.x, y: incoming.y }, ...others.flatMap(item => [
    { x: item.x - incoming.width - GAP, y: incoming.y }, { x: item.x + item.width + GAP, y: incoming.y },
    { x: incoming.x, y: item.y - incoming.height - GAP }, { x: incoming.x, y: item.y + item.height + GAP },
  ])].filter(point => Math.abs(point.x) <= 99000 && Math.abs(point.y) <= 99000 && fits({ ...incoming, ...point }))
    .sort((a, b) => ((a.x - incoming.x) ** 2 + 1.5 * (a.y - incoming.y) ** 2) - ((b.x - incoming.x) ** 2 + 1.5 * (b.y - incoming.y) ** 2) || a.y - b.y || a.x - b.x);
  const position = candidates.find(point => !others.some(item => overlaps({ ...incoming, ...point }, item)));
  if (!position) throw new Error('가까운 빈 공간을 찾지 못했습니다. 캔버스를 이동한 뒤 다시 추가해 주세요.');
  return { position, shifts: [] as PlacementShift[], fallback: true };
}
