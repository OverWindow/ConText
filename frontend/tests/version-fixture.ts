import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const workspace = '00000000-0000-0000-0000-000000000002';
export const newBody = Buffer.from('새 수정 이력 본문\n');
const hash = createHash('sha256').update(newBody).digest('hex');
export async function prepare(page: Page, role = 'OWNER', conversions: unknown[] = []) {
  const user = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.test-signature`;
  await page.context().addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + encode({ access_token: token, refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }), domain: 'localhost', path: '/' }]);
  const version = (id: string, number: number, docId: string, sha = 'a'.repeat(64)) => ({ id, document_id: docId, version_number: number, original_filename: `사업계획-${number}.md`, mime_type: 'text/markdown', size: 40, sha256: sha, status: 'READY', created_at: `2026-10-0${number}T00:00:00Z`, uploaded_at: '2026-10-01T00:00:00Z', author_name: '김지우', change_note: number === 1 ? '초안' : '가격 정책 수정', source_version_id: null as string | null });
  const doc = { id: 'doc-main', workspace_id: workspace, title: '사업계획서', current_version_id: 'v2', created_at: '2026-10-01T00:00:00Z', versions: [version('v1', 1, 'doc-main'), version('v2', 2, 'doc-main', 'b'.repeat(64))] };
  const source = { ...doc, id: 'doc-source', title: '외부 수정본', current_version_id: 'source-v1', versions: [version('source-v1', 1, 'doc-source', 'c'.repeat(64))] };
  const mutations: string[] = [];
  let uploaded = false;
  let duplicate = false;
  let failCompletion = false;
  await page.route('http://localhost:3102/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url()); const path = url.pathname;
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    let data: unknown;
    if (request.method() !== 'GET') mutations.push(path);
    if (path.endsWith('/current-version')) { doc.current_version_id = request.postDataJSON().version_id; data = doc; }
    else if (path.endsWith('/versions/link')) {
      expect(request.postDataJSON()).toMatchObject({ source_version_id: 'source-v1', change_note: '외부 수정본 연결' });
      doc.versions.push({ ...source.versions[0], id: 'v3', document_id: doc.id, version_number: 3, source_version_id: 'source-v1', change_note: '외부 수정본 연결' }); data = doc;
    } else if (path.endsWith('/upload-url')) {
      if (path.includes('/documents/doc-main/versions')) {
        expect(request.postDataJSON()).toMatchObject({ filename: '수정본.txt', size: newBody.length, sha256: hash, change_note: '수정 메모' });
        doc.versions.push({ ...version('v3', 3, doc.id, hash), original_filename: '수정본.txt', size: newBody.length, status: 'UPLOADING', uploaded_at: '', change_note: '수정 메모' });
      }
      data = { document_id: doc.id, version_id: 'v3', upload_url: 'http://localhost:3102/storage/upload', method: 'PUT', headers: { 'Content-Type': 'text/plain' }, expires_in: 600 };
    } else if (path.endsWith('/upload-complete')) {
      if (failCompletion) { failCompletion = false; await route.fulfill({ status: 503, json: { detail: '업로드 검증에 실패했습니다.' } }); return; }
      const v = doc.versions.at(-1)!; v.status = 'READY'; v.uploaded_at = '2026-10-08T00:00:00Z'; data = doc;
    } else if (path.endsWith('/compare')) {
      const left = doc.versions.find(v => v.id === url.searchParams.get('left')); const right = doc.versions.find(v => v.id === url.searchParams.get('right')); data = { left, right, identical: false };
    } else if (path.endsWith('/diff')) data = { counts: { added: 0, removed: 0, modified: 1, unchanged: 0 }, changes: [], total_changes: 1, truncated: false };
    else if (path.endsWith('/changes')) data = { state: 'COMPLETED', result: { warnings: ['AI_NOT_CONFIGURED'], summary: null } };
    else if (path.endsWith('/duplicates')) data = duplicate ? [{ document_id: doc.id, document_title: doc.title, version: doc.versions[0] }] : [];
    else if (path.endsWith('/processing')) data = { state: 'COMPLETED', error_message: null, summary: { block_count: 1, character_count: 20, page_count: null } };
    else if (path.endsWith('/content')) data = { blocks: [{ id: 1, type: 'paragraph', text: path.includes('/v1/') ? '초안의 가격은 100원입니다.' : '수정된 가격은 120원입니다.', source: {} }], total: 1, next_offset: null, warnings: [] };
    else if (path.endsWith('/members')) data = [{ id: user.id, display_name: '김지우', role }];
    else if (path.endsWith('/canvas')) data = { documents: [doc, source], positions: [], relations: [], conversions };
    else if (path.endsWith('/documents')) data = [doc, source];
    else if (path.endsWith('/documents/doc-main')) data = doc;
    else if (path.endsWith('/documents/doc-source')) data = source;
    else data = { id: workspace, name: '전략 워크스페이스', role };
    await route.fulfill({ json: data });
  });
  await page.route('http://localhost:3102/storage/upload', async route => { expect(route.request().headers().authorization).toBeUndefined(); expect(route.request().postDataBuffer()).toEqual(newBody); uploaded = true; await route.fulfill({ status: 200 }); });
  await page.goto(`/workspaces/${workspace}`);
  await page.locator('.react-flow__node[data-id="doc-main"]').click();
  await expect(page.getByRole('dialog', { name: '사업계획서', exact: true })).toBeVisible();
  return { doc, mutations, uploaded: () => uploaded, duplicate: () => { duplicate = true; }, failCompletion: () => { failCompletion = true; } };
}

