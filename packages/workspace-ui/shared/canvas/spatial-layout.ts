import type { FolderTreeEntry as Entry } from '../core/folder-tree';
import { fitFolder, FOLDER_MAX } from './folder-fit.ts';
import type { CanvasElement } from '../core/canvas';

type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };
type Frame = { width: number; height: number; fontScale?: number };
type Scope = { origin: Point; parentId?: string; inset: Point; scale: number; cardHeight: number; frame: Frame };
export type SpatialPlacement = {
  entry: Entry; position: Point; world: Point; width: number; height: number;
  visibilityScale: number; parentId?: string; directory: string; anchor: Point; inset: Point;
};
export type SpatialLayout = {
  placements: Map<string, SpatialPlacement>;
  scopes: Map<string, Scope>;
  bounds: Bounds;
};

// A bounded, ancestor-first inventory keeps large folders from mounting every file.
export function spatialEntries(entries: Entry[], limit: number, focusedDirectory = '') {
  const children = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = children.get(entry.parent_path) || [];
    list.push(entry); children.set(entry.parent_path, list);
  }
  const byPath = new Map(entries.map(entry => [entry.relative_path, entry]));
  const selected = new Set<string>();
  const append = (entry: Entry) => {
    if (selected.has(entry.id) || selected.size >= limit) return;
    const parent = byPath.get(entry.parent_path);
    if (parent) append(parent);
    if (selected.size < limit) selected.add(entry.id);
  };
  if (focusedDirectory && byPath.get(focusedDirectory)?.kind === 'directory') {
    append(byPath.get(focusedDirectory)!);
    for (const child of children.get(focusedDirectory) || []) append(child);
  }
  const queue = [...children.get('') || []];
  for (let i = 0; i < queue.length && selected.size < limit; i++) {
    const entry = queue[i]; append(entry);
    if (entry.kind === 'directory') queue.push(...children.get(entry.relative_path) || []);
  }
  // Keep sibling ordering stable as focus changes, and always mount parents first.
  return entries.filter(entry => selected.has(entry.id)).sort((a, b) => a.relative_path.split('/').length - b.relative_path.split('/').length);
}

const FOLDER_GAP = 48;
// A readable representative card is independent of a folder's total content bounds.
// Reserving its full name here prevents labels from spilling into neighbouring rows.
export function folderFrame(names: string[]): Frame {
  const fits = (width: number) => names.every(name => name.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(Array.from(line).length * 36 / (width - 48))), 0) * 48 + 192 <= width * 244 / 200);
  let width = 400;
  while (!fits(width)) width += 8;
  const fontScale = Math.min(1, FOLDER_MAX.width / width, FOLDER_MAX.height / (width * 244 / 200));
  return { width: width * fontScale, height: width * 244 / 200 * fontScale, fontScale };
}
function compactPosition(size: { width: number; height: number }, occupied: Bounds[], rowWidth: number): Point {
  const rows = [...new Set([0, ...occupied.map(item => item.y + item.height + FOLDER_GAP).filter(y => y >= 0)])].sort((a, b) => a - b);
  const obstacles = [...occupied].sort((a, b) => a.x - b.x);
  for (const y of rows) {
    let x = 0;
    for (const item of obstacles) {
      if (y >= item.y + item.height + FOLDER_GAP || y + size.height + FOLDER_GAP <= item.y) continue;
      if (x < item.x + item.width + FOLDER_GAP && x + size.width + FOLDER_GAP > item.x) x = item.x + item.width + FOLDER_GAP;
    }
    if (x + size.width <= rowWidth) return { x, y };
  }
  return { x: 0, y: Math.max(0, ...occupied.map(item => item.y + item.height)) + FOLDER_GAP };
}
function enclosing(items: Bounds[]): Bounds {
  const left = Math.min(0, ...items.map(item => item.x)), top = Math.min(0, ...items.map(item => item.y));
  return { x: left, y: top, width: Math.max(0, ...items.map(item => item.x + item.width)) - left, height: Math.max(0, ...items.map(item => item.y + item.height)) - top };
}

/** File coordinates stay local to their physical folder. Only their presentation is nested. */
export function spatialLayout(entries: Entry[], elements: Map<string, CanvasElement[]>, repackDirectory?: string, inventory: Entry[] = entries): SpatialLayout {
  const children = new Map<string, Entry[]>();
  for (const entry of inventory) { if (!entry.parent_path && !entries.some(item => item.id === entry.id)) continue; const list = children.get(entry.parent_path) || []; list.push(entry); children.set(entry.parent_path, list); }
  const presentations = new Map<string, { scale: number; cardHeight: number; frame: Frame }>();
  type Local = { entry: Entry; bounds: Bounds; anchor: Point; inset: Point; children?: Local[]; visibilityScale?: number };
  const shrink = (rows: Local[], directory: string, factor: number) => {
    const presentation = presentations.get(directory)!;
    presentation.scale *= factor;
    presentation.frame = { width: presentation.frame.width * factor, height: presentation.frame.height * factor, fontScale: (presentation.frame.fontScale || 1) * factor };
    for (const row of rows) {
      row.bounds = { x: row.bounds.x * factor, y: row.bounds.y * factor, width: row.bounds.width * factor, height: row.bounds.height * factor };
      row.visibilityScale = (row.visibilityScale || 1) * factor;
      row.inset = { x: row.inset.x * factor, y: row.inset.y * factor };
      if (row.children) shrink(row.children, row.entry.relative_path, factor);
    }
  };
  const layout = (directory: string): Local[] => {
    const items = children.get(directory) || [];
    const frame = folderFrame(items.filter(entry => entry.kind === 'directory').map(entry => entry.name));
    const scale = items.some(entry => entry.kind === 'directory') && items.some(entry => entry.kind !== 'directory') ? frame.width / 200 : 1;
    presentations.set(directory, { scale, frame, cardHeight: scale > 1 ? 244 : 290 });
    const rows: Local[] = items.filter(entry => entry.kind !== 'directory').map((entry, i) => {
      const anchor = { x: entry.x ?? i % 4 * 255, y: entry.y ?? Math.floor(i / 4) * 335 };
      const point = { x: anchor.x * scale, y: anchor.y * scale };
      return { entry, anchor, inset: { x: 0, y: 0 }, bounds: { ...point, width: 200 * scale, height: (scale > 1 ? 244 : 290) * scale } };
    });
    const elementBounds = (name: string) => { const factor = presentations.get(name)?.scale || 1; return (elements.get(name) || []).filter(e => e.kind !== 'text').map(e => ({ x: e.x * factor, y: e.y * factor, width: e.width * factor, height: e.height * factor })); };
    const occupied = [...rows.map(row => row.bounds), ...elementBounds(directory)];
    const regions = items.filter(entry => entry.kind === 'directory').map(entry => {
      const nested = layout(entry.relative_path);
      const content = enclosing([...nested.map(row => row.bounds), ...elementBounds(entry.relative_path)]);
      const fit = fitFolder(content, frame, (children.get(entry.relative_path) || []).length);
      if (fit.scale !== 1) shrink(nested, entry.relative_path, fit.scale);
      content.x *= fit.scale; content.y *= fit.scale; content.width *= fit.scale; content.height *= fit.scale;
      const inset = fit.inset;
      const size = { width: fit.width, height: fit.height };
      return { entry, nested, content, inset, size, fixed: !!entry.area_positioned && directory !== repackDirectory };
    });
    // Reserve deliberate placements before packing automatic regions into short rows.
    for (const region of regions.filter(region => region.fixed)) occupied.push({ x: (region.entry.x ?? 0) * scale + region.content.x, y: (region.entry.y ?? 0) * scale + region.content.y, ...region.size });
    const automatic = regions.filter(region => !region.fixed);
    const area = [...occupied, ...automatic.map(region => region.size)].reduce((sum, size) => sum + (size.width + FOLDER_GAP) * (size.height + FOLDER_GAP), 0);
    const rowWidth = Math.max(400, ...automatic.map(region => region.size.width), Math.ceil(Math.sqrt(area * 1.1)));
    for (const { entry, nested, content, inset, size, fixed } of regions) {
      const corner = fixed ? { x: (entry.x ?? 0) * scale + content.x, y: (entry.y ?? 0) * scale + content.y } : compactPosition(size, occupied, rowWidth);
      const anchor = { x: (corner.x - content.x) / scale, y: (corner.y - content.y) / scale };
      const bounds = { ...corner, ...size };
      rows.push({ entry, bounds, anchor, inset, children: nested });
      if (!fixed) occupied.push(bounds);
    }
    return rows;
  };
  const roots = layout(''), placements = new Map<string, SpatialPlacement>();
  const scopes: SpatialLayout['scopes'] = new Map([['', { origin: { x: 0, y: 0 }, inset: { x: 0, y: 0 }, ...presentations.get('')! }]]);
  const place = (rows: Local[], directory: string) => {
    const scope = scopes.get(directory)!;
    for (const row of rows) {
      const position = { x: row.bounds.x + scope.inset.x, y: row.bounds.y + scope.inset.y };
      const world = { x: row.bounds.x + scope.origin.x, y: row.bounds.y + scope.origin.y };
      placements.set(row.entry.id, { entry: row.entry, position, world, width: row.bounds.width, height: row.bounds.height, visibilityScale: row.visibilityScale || 1, parentId: scope.parentId, directory, anchor: row.anchor, inset: row.inset });
      if (row.children) {
        scopes.set(row.entry.relative_path, { parentId: row.entry.id, inset: row.inset, origin: { x: world.x + row.inset.x, y: world.y + row.inset.y }, ...presentations.get(row.entry.relative_path)! });
        place(row.children, row.entry.relative_path);
      }
    }
  };
  place(roots, '');
  return { placements, scopes, bounds: enclosing(roots.map(row => row.bounds)) };
}

export function storedPosition(layout: SpatialLayout, entry: Entry, position: Point) {
  const scope = layout.scopes.get(entry.parent_path);
  const placement = layout.placements.get(entry.id);
  return { id: entry.id, x: (placement?.anchor.x || 0) + (position.x - (placement?.position.x || 0)) / (scope?.scale || 1), y: (placement?.anchor.y || 0) + (position.y - (placement?.position.y || 0)) / (scope?.scale || 1) };
}


// Extend the bounded scene for cited files without repacking anything already on screen.
export function referenceScene(entries: Entry[], layout: SpatialLayout, inventory: Entry[], references: string[], elements: Map<string, CanvasElement[]>) {
  const included = new Set(entries.map(entry => entry.id)), byId = new Map(inventory.map(entry => [entry.id, entry])), byPath = new Map(inventory.map(entry => [entry.relative_path, entry]));
  const add = (entry: Entry) => {
    if (included.has(entry.id)) return;
    const parent = byPath.get(entry.parent_path); if (parent) add(parent);
    included.add(entry.id);
  };
  for (const id of references) { const entry = byId.get(id); if (entry) add(entry); }
  const baseIds = new Set(entries.map(entry => entry.id));
  const extra = inventory.filter(entry => included.has(entry.id) && !baseIds.has(entry.id)).sort((a, b) => a.relative_path.split('/').length - b.relative_path.split('/').length);
  if (!extra.length) return { entries, layout };
  const expandedEntries = [...entries, ...extra], expanded = spatialLayout(expandedEntries, elements);
  const placements = new Map(layout.placements), scopes = new Map(layout.scopes);
  for (const entry of extra) {
    if (placements.has(entry.id)) continue;
    const next = expanded.placements.get(entry.id)!, parent = scopes.get(entry.parent_path)!, nextParent = expanded.scopes.get(entry.parent_path)!;
    const directory = entry.kind === 'directory';
    const size = { width: directory ? next.width : 200 * parent.scale, height: directory ? next.height : parent.cardHeight * parent.scale };
    let local = { x: next.anchor.x * parent.scale + next.position.x - nextParent.inset.x - next.anchor.x * nextParent.scale, y: next.anchor.y * parent.scale + next.position.y - nextParent.inset.y - next.anchor.y * nextParent.scale };
    if (directory) {
      const occupied = [...placements.values()].filter(item => item.directory === entry.parent_path).map(item => ({ x: item.position.x - parent.inset.x, y: item.position.y - parent.inset.y, width: item.width, height: item.height }));
      occupied.push(...(elements.get(entry.parent_path) || []).map(item => ({ x: item.x * parent.scale, y: item.y * parent.scale, width: item.width * parent.scale, height: item.height * parent.scale })));
      if (occupied.some(item => local.x < item.x + item.width + FOLDER_GAP && local.x + size.width + FOLDER_GAP > item.x && local.y < item.y + item.height + FOLDER_GAP && local.y + size.height + FOLDER_GAP > item.y)) local = compactPosition(size, occupied, Math.max(size.width, Math.sqrt(occupied.reduce((area, item) => area + item.width * item.height, 0))));
    }
    const world = { x: parent.origin.x + local.x, y: parent.origin.y + local.y }, inset = next.inset;
    placements.set(entry.id, { ...next, ...size, position: { x: parent.inset.x + local.x, y: parent.inset.y + local.y }, world, parentId: parent.parentId, inset });
    if (directory) {
      const child = expanded.scopes.get(entry.relative_path)!;
      scopes.set(entry.relative_path, { ...child, origin: { x: world.x + inset.x, y: world.y + inset.y }, inset });
    }
  }
  return { entries: expandedEntries, layout: { ...layout, placements, scopes } };
}
