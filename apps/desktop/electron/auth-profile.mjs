/** Only the profile verified by ConText /api/me identifies a web account. */
export function accountProfile(value) {
  if (!value || typeof value.id !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.id) || typeof value.email !== 'string' || !value.email.trim() || value.email.length > 320) throw new Error('웹 계정 정보를 확인하지 못했습니다. 다시 로그인해 주세요.');
  return { id: value.id, email: value.email, display_name: typeof value.display_name === 'string' ? value.display_name.slice(0, 200) : null };
}

export function sessionTokens(value) {
  const expires_at = typeof value?.expires_at === 'number' ? value.expires_at : Date.now() / 1000 + value?.expires_in;
  if (typeof value?.access_token !== 'string' || !value.access_token || value.access_token.length > 32000 || typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 32000 || !Number.isFinite(expires_at) || expires_at <= Date.now() / 1000) throw new Error('로그인 세션 응답을 확인하지 못했습니다. 다시 로그인해 주세요.');
  return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at };
}
