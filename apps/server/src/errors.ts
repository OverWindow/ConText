export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function assert(value: unknown, code: string, message: string, status = 422): asserts value {
  if (!value) throw new ApiError(status, code, message);
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(value: unknown, label = 'id'): string {
  assert(typeof value === 'string' && uuidPattern.test(value), 'INVALID_ID', `${label} must be a UUID`);
  return value.toLowerCase();
}
export function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_BODY', 'A JSON object is required');
  return value as Record<string, unknown>;
}
export function pageLimit(value: unknown, maximum = 1000): number {
  const n = value === undefined ? Math.min(200, maximum) : Number(value);
  assert(Number.isSafeInteger(n) && n > 0 && n <= maximum, 'INVALID_LIMIT', `limit must be between 1 and ${maximum}`);
  return n;
}
