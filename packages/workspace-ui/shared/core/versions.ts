export type VersionItem = {
  id: string; version_number: number; original_filename: string; status: string;
  created_at?: string; uploaded_at?: string | null; author_name?: string; change_note?: string | null; source_version_id?: string | null;
  size: number; sha256: string;
};
export const verifiedVersion = (version: VersionItem) => !!version.uploaded_at || ['UPLOADED', 'PROCESSING', 'READY'].includes(version.status);
export const statusLabels: Record<string, string> = { PENDING: '업로드 대기', UPLOADING: '업로드 확인 필요', UPLOADED: '처리 대기', PROCESSING: '문서 분석 중', READY: '읽기 준비 완료', FAILED: '처리 실패' };
export type VersionDocument = { id: string; entry_id: string; title: string; current_version_id: string | null; file_version_id: string | null; revision: number; current_is_pinned: boolean; versions: VersionItem[] };
export type VersionCandidate = { document_id: string; document_title: string; version_id: string; version_number: number; score: number; exact_duplicate: boolean; filename_similarity: number; text_similarity: number; embedding_similarity: number | null; sampled: boolean; document_revision?: number };
export type VersionCandidates = { items: VersionCandidate[]; scanned: number; total: number; pending: number; limited: boolean };
