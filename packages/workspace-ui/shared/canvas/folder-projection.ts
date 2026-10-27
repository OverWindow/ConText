import { fitFolder, FOLDER_CAPACITY, FOLDER_MAX, type Box } from './folder-fit';

export type FolderItem = Box & { id: string; folder?: boolean; overlay?: boolean };
export type FolderProjection = ReturnType<typeof projectFolders>;

/** Derive hierarchy from canonical geometry, before applying any presentation scaling. */
export function projectFolders(items: FolderItem[]) {
  const folders = items.filter(item => item.folder).sort((a, b) => a.width * a.height - b.width * b.height || a.id.localeCompare(b.id));
  const owner = new Map<string, string>();
  const members = new Map(folders.map(item => [item.id, [] as FolderItem[]]));
  for (const item of items) {
    const parent = folders.find(folder => folder.id !== item.id && (!item.folder || folder.width * folder.height > item.width * item.height)
      && item.x >= folder.x && item.y >= folder.y && item.x + item.width <= folder.x + folder.width && item.y + item.height <= folder.y + folder.height);
    if (parent) { owner.set(item.id, parent.id); members.get(parent.id)!.push(item); }
  }
  const fits = new Map<string, ReturnType<typeof fitFolder>>();
  for (const folder of folders) {
    const children = members.get(folder.id)!;
    const boxes = children.filter(item => !item.overlay).map(item => ({ ...item, width: fits.get(item.id)?.width ?? item.width, height: fits.get(item.id)?.height ?? item.height }));
    const x = Math.min(0, ...boxes.map(item => item.x - folder.x));
    const y = Math.min(0, ...boxes.map(item => item.y - folder.y));
    const width = Math.max(0, ...boxes.map(item => item.x - folder.x + item.width)) - x;
    const height = Math.max(0, ...boxes.map(item => item.y - folder.y + item.height)) - y;
    const count = children.filter(item => item.folder || !item.id.startsWith('element:')).length;
    const fit = fitFolder({ x, y, width, height }, folder, count);
    // An ordinary, already-enclosed web folder keeps its exact saved appearance.
    if (count < FOLDER_CAPACITY && folder.width <= FOLDER_MAX.width && folder.height <= FOLDER_MAX.height && boxes.every(item => item.x + item.width <= folder.x + folder.width && item.y + item.height <= folder.y + folder.height)) {
      fits.set(folder.id, { width: folder.width, height: folder.height, scale: 1, inset: { x: 0, y: 0 } });
    } else fits.set(folder.id, fit);
  }
  const projected = new Map<string, Box & { scale: number }>();
  const byId = new Map(items.map(item => [item.id, item]));
  function place(item: FolderItem): Box & { scale: number } {
    const found = projected.get(item.id); if (found) return found;
    const parentId = owner.get(item.id), parent = parentId ? byId.get(parentId)! : undefined;
    const parentBox = parent ? place(parent) : undefined, fit = parent ? fits.get(parent.id)! : undefined;
    const scale = parentBox && fit ? parentBox.scale * fit.scale : 1;
    const intrinsic = fits.get(item.id) || item;
    const box = { x: parent && parentBox && fit ? parentBox.x + parentBox.scale * fit.inset.x + (item.x - parent.x) * scale : item.x,
      y: parent && parentBox && fit ? parentBox.y + parentBox.scale * fit.inset.y + (item.y - parent.y) * scale : item.y,
      width: intrinsic.width * scale, height: intrinsic.height * scale, scale };
    projected.set(item.id, box); return box;
  }
  items.forEach(place);
  const local = (folderId: string, point: { x: number; y: number }) => {
    const folder = byId.get(folderId)!, box = projected.get(folderId)!, fit = fits.get(folderId)!;
    return { x: folder.x + (point.x - box.x - fit.inset.x * box.scale) / (box.scale * fit.scale), y: folder.y + (point.y - box.y - fit.inset.y * box.scale) / (box.scale * fit.scale) };
  };
  return { owner, members, projected, local,
    contentScale(id: string) { return (projected.get(id)?.scale || 1) * (fits.get(id)?.scale || 1); },
    canonical(id: string, point: { x: number; y: number }) {
      const item = byId.get(id), box = projected.get(id);
      return item && box ? { x: item.x + (point.x - box.x) / box.scale, y: item.y + (point.y - box.y) / box.scale } : point;
    },
    into(folderId: string, point: { x: number; y: number }, size = { width: 200, height: 290 }) {
      const folder = byId.get(folderId)!, { x, y } = local(folderId, point);
      // Keep canonical membership inside a capped destination, even at its border.
      return { x: Math.max(folder.x, Math.min(folder.x + folder.width - size.width, x)), y: Math.max(folder.y, Math.min(folder.y + folder.height - size.height, y)) };
    },
  };
}
