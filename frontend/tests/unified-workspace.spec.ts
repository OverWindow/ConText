import { expect, test, type Page } from '@playwright/test';
import { applyCommand, createWorkspaceState } from '../../packages/domain/src/index';
import { createHash } from 'node:crypto';
import type { CommandEnvelope, EntityChange } from '../../packages/contracts/src/index';
const workspaceId = '00000000-0000-0000-0000-000000000002', actor = '00000000-0000-0000-0000-000000000001', root = '00000000-0000-0000-0000-000000000003', now = '2026-10-27T00:00:00.000Z';
async function fixture(page: Page, count = 2) {
    const user = { id: actor, email: 'test@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
    const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: actor, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.test-signature`;
    await page.context().addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + encode({ access_token: token, refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }), domain: 'localhost', path: '/' }]);
    let state = createWorkspaceState({ id: workspaceId, name: '통합 프로젝트', root_entry_id: root, epoch: 1, revision: 1, created_at: now, updated_at: now, deleted_at: null });
    const logs: {
        sequence: number;
        changes: EntityChange[];
    }[] = [], operations: CommandEnvelope[] = [], receipts = new Map<string, object>(), blobs = new Map<string, string>();
    let sequence = 0, lost = false;
    const conversions: { request_id: string; kind: string; format: string }[] = [];
    function command(c: CommandEnvelope) { operations.push(c); if (receipts.has(c.operation_id))
        return receipts.get(c.operation_id); const r = applyCommand(state, c, { actor_id: actor, role: 'OWNER', now: new Date().toISOString() }); state = r.state; if (r.changes.length)
        logs.push({ sequence: ++sequence, changes: r.changes }); const receipt = { operation_id: c.operation_id, status: r.status, changes: r.changes, conflict_ids: r.conflict_ids, sequence, error: r.error }; receipts.set(c.operation_id, receipt); return receipt; }
    for (let i = 0; i < count; i++) {
        const tail = String(i).padStart(12, '0'), id = `10000000-0000-0000-0000-${tail}`, doc = `20000000-0000-0000-0000-${tail}`, version = `30000000-0000-0000-0000-${tail}`, blob = `40000000-0000-0000-0000-${tail}`;
        state.entries[id] = { id, workspace_id: workspaceId, parent_id: root, name: i === count - 1 ? '마지막 문서.md' : `문서-${String(i).padStart(5, '0')}.md`, kind: 'file', document_id: doc, revision: 1, position_revision: 0, x: null, y: null, area_positioned: false, deleted_at: null };
        state.documents[doc] = { id: doc, workspace_id: workspaceId, content_head_id: i < 2 ? version : null, reference_head_id: i < 2 ? version : null, reference_pinned: false, revision: 1, deleted_at: null };
        if (i < 2) {
            const original = Buffer.from('기존 원본 내용');
            state.versions[version] = { id: version, workspace_id: workspaceId, document_id: doc, blob: { id: blob, sha256: createHash('sha256').update(original).digest('hex'), size: original.length, mime_type: 'text/markdown' }, parent_version_ids: [], sources: [], created_at: now, created_by: actor, change_note: '기존 원본', display_number: 1 };
            blobs.set(blob, '기존 원본 내용');
        }
    }
    const note = '50000000-0000-0000-0000-000000000001';
    state.canvas_elements[note] = { id: note, workspace_id: workspaceId, scope_id: root, kind: 'text', content: '데스크톱과 같은 메모', color: 'violet', x: -400, y: 0, width: 320, height: 160, sources: [], revision: 1, deleted_at: null };
    const draft = '60000000-0000-0000-0000-000000000001';
    state.drafts[draft] = { id: draft, workspace_id: workspaceId, scope_id: root, title: '공유 초안', content: JSON.stringify({ title: '공유 초안', blocks: [{ id: 'b', type: 'paragraph', text: '데스크톱에서 쓴 초안', level: 1, items: [], rows: [], source_ids: ['legacy-note'] }] }), sources: [{ id: '60000000-0000-0000-0000-000000000002', kind: 'note', element_id: note, scope_id: root, quote: '인용한 메모 내용', label: '메모 출처', metadata: { legacy_id: 'legacy-note' } }], history: [], revision: 1, review: null, deleted_at: null };
    await page.route('http://localhost:3102/**', async (route) => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname, body = req.method() === 'POST' ? req.postDataJSON() : null;
        let data: unknown = {};
        if (path === '/test-artifact') {
            await route.fulfill({ body: '변환된 파일 내용', contentType: 'text/plain', headers: { 'access-control-allow-origin': '*', 'content-disposition': 'attachment; filename=converted.txt' } });
            return;
        }
        if (path.includes('/test-bytes/')) {
            const id = path.split('/').at(-1)!;
            if (req.method() === 'PUT') {
                blobs.set(id, req.postDataBuffer()?.toString() || '');
                await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' });
                return;
            }
            await route.fulfill({ body: blobs.get(id) || '', contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } });
            return;
        }
        if (path.endsWith('/workspaces')) data = { workspaces: [{ id: workspaceId, name: '통합 프로젝트', role: 'OWNER' }] };
        else if (path.endsWith('/me'))
            data = { id: actor, email: user.email };
        else if (path.endsWith('/bootstrap'))
            data = { state, cursor: sequence, epoch: state.workspace.epoch, role: 'OWNER' };
        else if (path.endsWith('/devices'))
            data = { binding: { device_id: body?.device_id } };
        else if (path.endsWith('/changes')) {
            const after = Number(url.searchParams.get('after') || 0), changes = logs.filter(v => v.sequence > after);
            data = { changes, cursor: changes.at(-1)?.sequence || after, has_more: false, epoch: state.workspace.epoch };
        }
        else if (path.endsWith('/commands')) {
            const results = body.commands.map(command);
            if (lost) {
                lost = false;
                await route.abort('failed');
                return;
            }
            data = { results, cursor: sequence, epoch: state.workspace.epoch };
        }
        else if (path.endsWith('/entries') || path.endsWith('/search')) {
            const q = url.searchParams.get('q') || '', parent = url.searchParams.get('parent_id') || root, cursor = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit') || 200), entries = Object.values(state.entries).filter(v => v.id !== root && !v.deleted_at && (path.endsWith('/search') ? v.name.includes(q) : v.parent_id === parent)).sort((a, b) => a.name.localeCompare(b.name));
            data = { entries: entries.slice(cursor, cursor + limit), next_cursor: cursor + limit < entries.length ? String(cursor + limit) : null, has_more: cursor + limit < entries.length };
        }
        else if (path.endsWith('/blobs/prepare')) {
            blobs.set(body.id, '');
            data = { blob: body, already_uploaded: false, upload_url: `http://localhost:3102/test-bytes/${body.id}`, headers: { 'content-type': body.mime_type } };
        }
        else if (path.endsWith('/blobs/complete'))
            data = { verified: true };
        else if (path.endsWith('/processing')) { conversions.push(body); data = { job_id: body.request_id }; }
        else if (path.includes('/jobs/')) data = { status: 'complete', result: { artifact_id: 'converted' } };
        else if (path.endsWith('/artifacts/converted/download')) data = { url: 'http://localhost:3102/test-artifact' };
        else if (path.endsWith('/download')) {
            const v = state.versions[path.split('/').at(-2)!];
            data = { url: `http://localhost:3102/test-bytes/${v.blob.id}`, version: v };
        }
        else if (path.endsWith('/ai/index-status'))
            data = { ready: 0, jobs: [] };
        else if (path.endsWith('/ai/search'))
            data = { results: [] };
        else if (path.endsWith('/conflicts'))
            data = { conflicts: Object.values(state.conflicts) };
        await route.fulfill({ json: data, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole('heading').filter({ hasText: '통합 프로젝트' })).toBeVisible({ timeout: 30000 });
    return { operations, conversions, state: () => state, loseNextAck: () => { lost = true; }, remoteNote: () => command({ schema_version: 2, operation_id: crypto.randomUUID(), workspace_id: workspaceId, device_id: root, workspace_epoch: 1, type: 'PutCanvasElement', payload: { element: { ...state.canvas_elements[note], content: '다른 기기에서 저장한 메모' } }, base_revisions: { ['canvas_elements:' + note]: state.canvas_elements[note].revision } }) };
}
test('shared canvas and text originals use named commands', async ({ page }) => { const f = await fixture(page); await expect(page.getByText('데스크톱과 같은 메모', { exact: true })).toBeVisible(); if (!await page.getByRole('button', { name: '새 폴더', exact: true }).isVisible()) await page.getByRole('button', { name: '워크스페이스 설정', exact: true }).click(); await page.getByRole('button', { name: '새 폴더', exact: true }).click(); await page.getByRole('textbox', { name: '이름', exact: true }).fill('웹 기획'); await page.getByRole('button', { name: '확인', exact: true }).click(); await expect.poll(() => Object.values(f.state().entries).some(v => v.name === '웹 기획')).toBe(true); await page.getByRole('button', { name: '문서 관리', exact: true }).click(); await page.getByRole('button', { name: '문서-00000.md', exact: true }).click(); await page.getByRole('button', { name: '텍스트 편집', exact: true }).click(); await page.getByRole('textbox', { name: '원본 텍스트' }).fill('웹에서 수정한 원본'); await page.getByRole('button', { name: '원본 저장', exact: true }).click(); await expect(page.getByText('저장됨', { exact: true })).toBeVisible(); expect(f.operations.some(c => c.type === 'AppendDocumentVersion')).toBe(true); expect(Object.keys(f.state().versions)).toHaveLength(3);
await page.getByRole('button', { name: '텍스트 편집 닫기', exact: true }).click();
await page.getByRole('button', { name: '문서 관리', exact: true }).click();
await page.getByRole('button', { name: '문서-00000.md', exact: true }).click();
await expect(page.getByRole('navigation', { name: '문서 수정 이력 메뉴', exact: true }).getByRole('button')).toHaveCount(4);
await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
await page.getByRole('button', { name: '비교하기', exact: true }).click();
const comparison = page.getByRole('region', { name: '수정 이력 비교', exact: true });
await expect(comparison.getByText('기존 원본 내용', { exact: true })).toBeVisible();
await expect(comparison.getByText('웹에서 수정한 원본', { exact: true })).toBeVisible();
});
test('file actions require a click and previews require a double click', async ({ page }, info) => {
  const f = await fixture(page);
  const card = page.getByTestId('file-문서-00000.md');
  await card.hover();
  await expect(card.getByRole('button', { name: '문서-00000.md 복사본 생성하기', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '문서-00000.md 형식 변환', exact: true })).toHaveCount(0);
  await card.locator('.paper-caption').click();
  await expect(page.getByRole('button', { name: '미리보기 닫기', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '문서-00000.md 복사본 생성하기', exact: true })).toBeVisible();
  await page.mouse.move(4, 4);
  await expect(card.getByRole('button', { name: '문서-00000.md 형식 변환', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '문서-00000.md 형식 변환', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '문서-00000.md 형식 변환 패널' });
  await expect(panel.getByRole('button', { name: 'TXT 변환', exact: true })).toBeEnabled();
  await expect(panel).toHaveCSS('opacity', '1');
  await expect(panel.locator('.conversion-tray-body')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: `test-results/file-click-web-${info.project.name}.png` });
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'TXT 변환', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('converted.txt');
  expect(f.conversions).toHaveLength(1);
  expect(f.conversions[0]).toMatchObject({ kind: 'convert', format: 'txt' });
  await panel.getByRole('button', { name: '형식 변환 닫기', exact: true }).click();
  await card.getByRole('button', { name: '문서-00000.md 복사본 생성하기', exact: true }).click();
  await expect.poll(() => Object.values(f.state().entries).filter(e => e.name === '문서-00000 copy.md').length).toBe(1);
  await expect(page.getByRole('button', { name: '미리보기 닫기', exact: true })).toHaveCount(0);
  await page.locator('.statusbar').click();
  await expect(card.getByRole('button', { name: '문서-00000.md 복사본 생성하기', exact: true })).toHaveCount(0);
  await card.locator('.paper-caption').dblclick();
  await expect(page.getByRole('button', { name: '미리보기 닫기', exact: true })).toBeVisible();
  await expect(page.getByText('기존 원본 내용', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '미리보기 닫기', exact: true }).click();
  await card.focus(); await page.keyboard.press('Space');
  await expect(card.getByRole('button', { name: '문서-00000.md 복사본 생성하기', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '미리보기 닫기', exact: true })).toBeVisible();
});
test('25001 entries remain searchable and folder lists paginate', async ({ page }) => { test.setTimeout(90000); await fixture(page, 25001); await page.getByRole('button', { name: '문서 관리', exact: true }).click(); await expect(page.getByText('200개 표시 · 뒤에 더 있음')).toBeVisible(); await page.getByRole('button', { name: '다음 파일 더 보기' }).click(); await expect(page.getByText('400개 표시 · 뒤에 더 있음')).toBeVisible(); await page.getByRole('button', { name: '문서 관리 닫기' }).click(); await page.getByRole('textbox', { name: '파일 이름 검색' }).fill('마지막 문서'); await page.getByRole('button', { name: '검색', exact: true }).click(); await expect(page.getByRole('button', { name: '마지막 문서.md', exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); });
test('lost ACK replays one persisted operation after restart', async ({ page }) => { const f = await fixture(page); f.loseNextAck(); if (!await page.getByRole('button', { name: '새 폴더', exact: true }).isVisible()) await page.getByRole('button', { name: '워크스페이스 설정', exact: true }).click(); await page.getByRole('button', { name: '새 폴더', exact: true }).click(); await page.getByRole('textbox', { name: '이름', exact: true }).fill('응답 유실 폴더'); await page.getByRole('button', { name: '확인', exact: true }).click(); await expect(page.getByRole('alert').first()).toBeVisible(); await page.reload(); await expect(page.getByRole('heading').filter({ hasText: '통합 프로젝트' })).toBeVisible({ timeout: 30000 }); expect(Object.values(f.state().entries).filter(v => v.name === '응답 유실 폴더')).toHaveLength(1); const commands = f.operations.filter(c => c.type === 'CreateEntry'); expect(commands.length).toBeGreaterThanOrEqual(2); expect(new Set(commands.map(c => c.operation_id)).size).toBe(1); });
test('shared drafts retain note-source quotes and legacy citation IDs', async ({ page }) => { await fixture(page); await page.getByRole('button', { name: 'AI 문서 작성', exact: true }).click(); await page.getByRole('button', { name: '공유 초안', exact: true }).click(); await expect(page.getByText('데스크톱에서 쓴 초안', { exact: true })).toBeVisible(); await page.getByText('메모 출처', { exact: true }).click(); await expect(page.getByText('인용한 메모 내용', { exact: true })).toBeVisible(); });
test('concurrent note edits preserve both sides and resolve from the conflict view', async ({ page }) => { const f = await fixture(page); await page.getByRole('button', { name: '캔버스 수정', exact: true }).click(); await page.getByRole('button', { name: '전체 보기', exact: true }).click(); await page.getByRole('group', { name: '캔버스 텍스트', exact: true }).click(); await page.getByRole('textbox', { name: '캔버스 텍스트 내용' }).fill('이 기기에서 쓴 메모'); f.remoteNote(); await expect.poll(() => Object.values(f.state().conflicts).filter(v => v.status === 'open').length).toBe(1); await page.getByRole('button', { name: '충돌 확인 필요', exact: true }).click(); await page.getByRole('button', { name: /충돌과 복구 자료/ }).click(); await expect(page.getByRole('dialog', { name: '동기화 상태와 충돌' }).getByText('이 기기에서 쓴 메모', { exact: true })).toBeVisible(); await expect(page.getByText('다른 기기에서 저장한 메모', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '보존된 변경 적용', exact: true }).click(); await expect.poll(() => f.state().canvas_elements['50000000-0000-0000-0000-000000000001'].content).toBe('이 기기에서 쓴 메모'); await expect.poll(() => Object.values(f.state().conflicts).filter(v => v.status === 'open').length).toBe(0); });


test('rejected input stays visible after reload and exports from recovery', async ({ page }) => {
  await fixture(page);
  for (let i=0;i<2;i++) {
    if (!await page.getByRole('button', { name: '새 폴더', exact: true }).isVisible()) await page.getByRole('button', { name: '워크스페이스 설정', exact: true }).click(); await page.getByRole('button', { name: '새 폴더', exact: true }).click();
    await page.getByRole('textbox', { name: '이름', exact: true }).fill('중복 폴더');
    await page.getByRole('button', { name: '확인', exact: true }).click();
    if (!i) await expect(page.getByRole('dialog', { name: '새 폴더' })).toHaveCount(0);
  }
  await expect(page.getByRole('dialog', { name: '새 폴더' }).getByRole('alert')).toContainText('보존');
  await page.reload(); await page.getByRole('button', { name: /충돌 확인 필요/ }).click(); await page.getByRole('button', { name: /충돌과 복구 자료/ }).click();
  const recovery = page.getByRole('region', { name: '동기화 복구 자료' });
  await recovery.getByText('보존된 내용 보기').click(); await expect(recovery.getByText('중복 폴더', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await recovery.getByRole('button', { name: '복구 기록 내보내기' }).click(); expect((await download).suggestedFilename()).toMatch(/^context-recovery-.*\.json$/);
});

 test('application menus, account and sync chrome share the desktop layout', async ({ page }, info) => {
  await fixture(page);
  await expect(page.locator('[data-application-shell="shared"]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '연결된 워크스페이스' })).toHaveCount(0);
  await expect(page.locator('.context-navigation .application-space')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '나의 워크스페이스', exact: true })).toBeVisible();
  expect(await page.getByRole('navigation', { name: '워크스페이스 메뉴', exact: true }).getByRole('button').evaluateAll(items => items.map(item => item.getAttribute('aria-label')))).toEqual(['캔버스', '문서 관리', 'AI 문서 작성', 'AI 채팅', 'AI 연결 설정']);
  await expect(page.locator('[data-application-shell="shared"]>.context-navigation')).toHaveCSS('width', info.project.name === 'mobile' ? '58px' : '242px');
  await expect(page.locator('[data-application-shell="shared"]>.context-navigation')).toHaveCSS('border-radius', '0px');
  await page.getByRole('button', { name: '서버 반영됨', exact: true }).click();
  await expect(page.getByRole('region', { name: '동기화 상태', exact: true })).toContainText('다른 기기의 파일 적용 상태는 해당 기기에서 확인하세요.');
  await page.screenshot({ path: `test-results/application-web-${info.project.name}.png` });
  await page.getByRole('button', { name: '서버 반영됨', exact: true }).click();
  await page.getByRole('button', { name: '계정 관리', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'ConText 계정', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '완료', exact: true }).click();
  await page.getByRole('button', { name: '나의 워크스페이스', exact: true }).click();
  await expect(page.locator('[data-application-home="shared"]')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '주 메뉴' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '나의 워크스페이스', exact: true })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '워크스페이스 이름', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '계정 관리', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.application-home-brand img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/application-web-home-${info.project.name}.png` });
  await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
  await expect(page.locator('[data-sample-workspace="harulab"]')).toBeVisible();
  await page.getByRole('button', { name: '나의 워크스페이스', exact: true }).click();
  await page.locator('.application-space-grid > li > button').first().click();
  await expect(page.getByRole('navigation', { name: '워크스페이스 메뉴', exact: true })).toBeVisible();
 });
