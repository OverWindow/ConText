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

export type ExportFormat = "docx" | "hwpx" | "pdf" | "txt" | "md";
export interface DraftRepository {
  list(): Promise<{ id: string; title: string }[]>;
  get(id: string): Promise<WritingDraft>;
  create(requestId: string): Promise<WritingDraft>;
  save(id: string, revision: number, content: WritingContent): Promise<WritingDraft>;
  generate(input: { draftId?: string; revision?: number; prompt: string; requestId: string }): Promise<WritingDraft>;
  review(id: string, revision: number, action: "accept" | "reject" | "undo"): Promise<WritingDraft>;
  remove(id: string, revision: number): Promise<void>;
  export(id: string, revision: number, format: ExportFormat): Promise<void>;
}
