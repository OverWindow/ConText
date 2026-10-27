export type Box = { x: number; y: number; width: number; height: number };
export const FOLDER_CAPACITY = 8;
export const FOLDER_MAX = { width: 1093, height: 793 };
export const FOLDER_INSET = { x: 64, y: 88 };

/** Presentation only. Persisted coordinates and ownership never depend on zoom. */
export function fitFolder(content: Box, minimum: { width: number; height: number }, count: number) {
  const width = count >= FOLDER_CAPACITY ? FOLDER_MAX.width : Math.min(FOLDER_MAX.width, Math.max(minimum.width, content.width + 128));
  const height = count >= FOLDER_CAPACITY ? FOLDER_MAX.height : Math.min(FOLDER_MAX.height, Math.max(minimum.height, content.height + 168));
  const scale = Math.min(1, (width - 128) / Math.max(1, content.width), (height - 168) / Math.max(1, content.height));
  return { width, height, scale, inset: { x: FOLDER_INSET.x - content.x * scale, y: FOLDER_INSET.y - content.y * scale } };
}
