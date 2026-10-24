import type { DocumentNode } from "./document-card";
import type { ElementNode } from "./canvas-elements";

export type FolderBounds = { x: number; y: number; width: number; height: number };
export type FolderChange = { id: string; before: FolderBounds; after: FolderBounds };
type FileMove = { id: string; origin: { x: number; y: number }; position: { x: number; y: number } };
const FILE_PADDING = 48;
const NAME_PADDING = 80;
const boundsOf = (node: ElementNode): FolderBounds => ({ ...node.position, width: node.width ?? node.data.element.width, height: node.height ?? node.data.element.height });

export function applyFolderBounds(node: ElementNode, bounds: FolderBounds): ElementNode {
  return { ...node, position: { x: bounds.x, y: bounds.y }, width: bounds.width, height: bounds.height,
    style: { ...node.style, width: bounds.width, height: bounds.height }, data: { ...node.data, element: { ...node.data.element, ...bounds } } };
}

// Compute against saved bounds, never the previous preview, to avoid sticky growth.
export function planFolderMove(elements: ElementNode[], documents: DocumentNode[], moves: FileMove[]) {
  const original = folderMembership(elements, documents.map(node => {
    const move = moves.find(item => item.id === node.id);
    return move ? { ...node, position: move.origin } : node;
  }));
  const current = documents.map(node => {
    const move = moves.find(item => item.id === node.id);
    return move ? { ...node, position: move.position } : node;
  });
  const destinations = new Map<string, string>();
  const changes = new Map<string, FolderChange>();
  let tooLarge = false;
  let expanded = elements;
  for (const move of moves) {
    const document = current.find(node => node.id === move.id);
    if (!document) continue;
    const expansion = folderDropExpansion(expanded, document);
    if (!expansion) continue;
    if (expansion.tooLarge) { tooLarge = true; continue; }
    destinations.set(move.id, `element:${expansion.id}`);
    changes.set(expansion.id, { ...expansion, before: changes.get(expansion.id)?.before ?? expansion.before });
    expanded = expanded.map(node => node.data.element.id === expansion.id ? applyFolderBounds(node, expansion.after) : node);
  }
  const leaving = moves.filter(move => original.owner.has(move.id) && original.owner.get(move.id) !== destinations.get(move.id));
  for (const sourceId of new Set(leaving.map(move => original.owner.get(move.id)!))) {
    // A folder receiving another file keeps its newly expanded dimensions.
    if ([...destinations.values()].includes(sourceId)) continue;
    const source = elements.find(node => node.id === sourceId)!;
    const before = boundsOf(source);
    const remaining = (original.members.get(sourceId) || []).filter(node => !leaving.some(move => move.id === node.id));
    const minWidth = Math.min(320, before.width), minHeight = Math.min(240, before.height);
    let x: number, y: number, right: number, bottom: number;
    if (remaining.length) {
      x = Math.max(before.x, Math.min(...remaining.map(node => node.position.x)) - FILE_PADDING);
      y = Math.max(before.y, Math.min(...remaining.map(node => node.position.y)) - FILE_PADDING);
      right = Math.min(before.x + before.width, Math.max(...remaining.map(node => node.position.x + (node.measured?.width ?? 200))) + FILE_PADDING);
      bottom = Math.min(before.y + before.height, Math.max(...remaining.map(node => node.position.y + (node.measured?.height ?? 290))) + NAME_PADDING);
    } else {
      x = before.x + (before.width - minWidth) / 2; y = before.y + (before.height - minHeight) / 2;
      right = x + minWidth; bottom = y + minHeight;
    }
    const width = Math.max(minWidth, right - x), height = Math.max(minHeight, bottom - y);
    const after = { x: Math.min(x, before.x + before.width - width), y: Math.min(y, before.y + before.height - height), width, height };
    changes.set(source.data.element.id, { id: source.data.element.id, before, after });
  }
  return { changes: [...changes.values()].filter(({ before, after }) => (Object.keys(before) as (keyof FolderBounds)[]).some(key => before[key] !== after[key])), tooLarge };
}

// Drop by the card's centre, then grow the folder without moving existing files.
export function folderDropExpansion(elements: ElementNode[], document: DocumentNode) {
  const width = document.measured?.width ?? 200;
  const height = document.measured?.height ?? 290;
  const cx = document.position.x + width / 2, cy = document.position.y + height / 2;
  const candidates = elements.filter(node => node.data.element.kind === "rectangle")
    .map(node => ({ node, bounds: { ...node.position, width: node.width ?? node.data.element.width, height: node.height ?? node.data.element.height } }))
    .map(item => ({ ...item, distance: Math.hypot(Math.max(item.bounds.x - cx, 0, cx - item.bounds.x - item.bounds.width), Math.max(item.bounds.y - cy, 0, cy - item.bounds.y - item.bounds.height)) }))
    // A 40px canvas-space margin makes edge drops forgiving. Prefer an actual
    // enclosure, then the nearest edge, so adjacent folders do not steal drops.
    .filter(item => item.distance <= 40)
    .sort((a, b) => a.distance - b.distance || a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height || a.node.id.localeCompare(b.node.id));
  const target = candidates[0];
  if (!target) return null;
  const before = target.bounds;
  const x = Math.max(-100000, Math.min(before.x, document.position.x - FILE_PADDING));
  const y = Math.max(-100000, Math.min(before.y, document.position.y - FILE_PADDING));
  const after = { x, y, width: Math.max(before.x + before.width, document.position.x + width + FILE_PADDING) - x,
    height: Math.max(before.y + before.height, document.position.y + height + NAME_PADDING) - y };
  if (after.width > 2000 || after.height > 2000) return { id: target.node.data.element.id, before, after, tooLarge: true };
  return { id: target.node.data.element.id, before, after, tooLarge: false };
}

// Folder membership follows the saved canvas geometry. Overlapping folders use
// the smallest complete enclosure, with a stable ID tie-breaker.
export function folderMembership(elements: ElementNode[], documents: DocumentNode[]) {
  const folders = elements.filter(node => node.data.element.kind === "rectangle")
    .map(node => ({ node, width: node.width ?? node.data.element.width, height: node.height ?? node.data.element.height }))
    .sort((a, b) => a.width * a.height - b.width * b.height || a.node.id.localeCompare(b.node.id));
  const owner = new Map<string, string>();
  const members = new Map(folders.map(({ node }) => [node.id, [] as DocumentNode[]]));
  for (const document of documents) {
    const width = document.measured?.width ?? 200;
    const height = document.measured?.height ?? 290;
    const folder = folders.find(({ node, width: w, height: h }) => document.position.x >= node.position.x && document.position.y >= node.position.y
      && document.position.x + width <= node.position.x + w && document.position.y + height <= node.position.y + h);
    if (folder) {
      owner.set(document.id, folder.node.id);
      members.get(folder.node.id)!.push(document);
    }
  }
  return { owner, members };
}
