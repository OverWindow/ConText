export type NormalizedBlock = {
  id: number; type: string; text: string;
  source: { page?: number; section?: string; element?: number; line?: number; paragraph?: number };
  rows?: string[][]; level?: number;
};
export type NormalizedDocument = { schema_version: number; title: string; blocks: NormalizedBlock[]; warnings: string[]; page_count: number | null };
export type LocalDocument = {
  document_id: string; entry_id: string; version_id: string; version_number: number;
  filename: string; sha256: string; created_at: number; normalized: NormalizedDocument;
};
