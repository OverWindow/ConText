export type WritingBlock = {
  id: string; type: "paragraph" | "heading" | "list" | "table";
  text: string; level: number; items: string[]; rows: string[][]; source_ids: string[];
};
export type WritingContent = { title: string; blocks: WritingBlock[] };
export type WritingSource = {
  id: string; kind: string; document_title: string; text: string;
  version_number?: number; is_current?: boolean; updated_at?: string;
  locations?: { page?: number; block_id?: number }[];
};
export type WritingDraft = {
  id: string; title: string; revision: number; content: WritingContent;
  sources: WritingSource[]; checks: string[]; can_undo: boolean;
  proposal: { content: WritingContent; sources: WritingSource[]; checks: string[] } | null;
};
export function blockText(block: WritingBlock) {
  return block.type === "list" ? block.items.join("\n") : block.type === "table" ? block.rows.map(r => r.join(" | ")).join("\n") : block.text;
}
