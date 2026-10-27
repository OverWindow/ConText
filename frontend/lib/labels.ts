export const roles = { OWNER: "소유자", EDITOR: "편집자", VIEWER: "열람자" };
export { statusLabels as statuses } from '../shared/core/versions';
export function message(error: unknown) { return error instanceof Error ? error.message : "요청을 완료하지 못했습니다. 다시 시도해 주세요."; }
