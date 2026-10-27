export type VisibleFolder = { id: string; parentId?: string; scale: number; contentScale?: number };
export function folderVisibility(folders: VisibleFolder[], zoom: number, previous = new Set<string>(), forced = new Set<string>(), bypass = false) {
  const opened = new Set(folders.filter(folder => bypass || forced.has(folder.id) || zoom * folder.scale >= .42 || previous.has(folder.id) && zoom * folder.scale > .34).map(folder => folder.id));
  const parents = new Map(folders.map(folder => [folder.id, folder.parentId]));
  const hidden = (parentId?: string) => {
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      if (!opened.has(parentId)) return true;
      seen.add(parentId); parentId = parents.get(parentId);
    }
    return false;
  };
  const visible = folders.filter(folder => !hidden(folder.parentId));
  return { opened, hidden, maxZoom: Math.max(2, ...visible.map(folder => 2 / Math.max(.000001, Math.min(folder.scale, folder.contentScale ?? folder.scale)))) };
}
