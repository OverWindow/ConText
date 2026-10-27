export type Source = { id: string; chunk_id: string; document_id: string; document_title: string; version_id: string; version_number: number; is_current: boolean; text: string; locations: { block_id: number; page?: number; line?: number }[]; kind?: 'document' | 'note' | 'chat' | 'draft'; available?: boolean };

export function sourceLabel(id: string, sources: Source[]) {
  const index = sources.findIndex(source => source.id === id);
  return index < 0 ? '출처' : `S${index + 1}`;
}
