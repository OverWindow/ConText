export const roles = { OWNER: "소유자", EDITOR: "편집자", VIEWER: "열람자" };
export const statuses: Record<string, string> = { PENDING: "업로드 대기", UPLOADING: "업로드 확인 필요", UPLOADED: "처리 대기", PROCESSING: "문서 분석 중", READY: "읽기 준비 완료", FAILED: "처리 실패" };
export function message(error: unknown) { return error instanceof Error ? error.message : "요청을 완료하지 못했습니다. 다시 시도해 주세요."; }
