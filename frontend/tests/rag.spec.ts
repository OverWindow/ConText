import { expect, test, type Page } from '@playwright/test';
import { prepare } from './version-fixture';

const source = { id: 'S1', chunk_id: 'chunk-1', document_id: 'doc-main', document_title: '사업계획서', version_id: 'v1', version_number: 1, is_current: false, text: '초안의 가격은 100원입니다. <script>alert(1)</script>', locations: [{ block_id: 1, page: 2 }] };
const evidence = { sources: [source], scope: 'history', as_of: null, warnings: [] as string[] };
const result = { ...evidence, claims: [{ text: '초안의 가격은 100원입니다.', source_ids: ['S1'] }], insufficient: false };
async function setup(page: Page, options: { viewer?: boolean; failed?: boolean; lost?: boolean } = {}) {
  await prepare(page, options.viewer ? 'VIEWER' : 'OWNER');
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  let sessions: { id: string; title: string }[] = [];
  let messages: object[] = [];
  const asks: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  const searches: Record<string, unknown>[] = [];
  let lost = options.lost;
  await page.route('http://localhost:3102/api/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (path.endsWith('/rag/status')) { const counts = { versions: 2, completed: 2, failed: 0, chunks: 3, indexed_chunks: 3 }; await route.fulfill({ json: { current: counts, all: counts } }); }
    else if (path.endsWith('/chat/sessions')) {
      if (req.method() === 'POST') { creates.push(req.postDataJSON()); sessions = [{ id: 'session-1', title: '가격 정책' }]; await route.fulfill({ json: sessions[0], status: 201 }); }
      else await route.fulfill({ json: sessions });
    } else if (path.endsWith('/messages')) {
      if (req.method() === 'POST') {
        const data = req.postDataJSON(); asks.push(data);
        const user = { id: 'question-1', role: 'user', state: 'COMPLETED', content: data.question, result: null };
        const response = { id: 'answer-1', role: 'assistant', state: options.failed ? 'FAILED' : 'COMPLETED', content: '초안의 가격은 100원입니다.', result: options.failed ? null : result, error_code: options.failed ? 'AI_INVALID_RESPONSE' : null };
        messages = [user, response];
        if (lost) { lost = false; await route.abort('failed'); return; }
        await route.fulfill({ status: 202, json: { ...response, state: 'QUEUED', result: null } });
      } else await route.fulfill({ json: messages });
    } else if (path.endsWith('/retry')) {
      messages = [messages[0], { id: 'answer-1', role: 'assistant', state: 'COMPLETED', content: '근거 없음', result: { ...evidence, sources: [], claims: [], insufficient: true } }];
      await route.fulfill({ json: {} });
    } else if (path.endsWith('/search')) { searches.push(req.postDataJSON()); await route.fulfill({ json: { ...evidence, warnings: ['INDEX_INCOMPLETE', 'SEMANTIC_UNAVAILABLE'] } }); }
    else await route.fallback();
  });
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '문서 AI 채팅' })).toBeVisible();
  await expect(page.getByText('현재 문서 2/2개 검색 준비', { exact: false })).toBeVisible();
  return { asks, creates, searches };
}

test('grounded shared chat, citations, historical source, and persistence', async ({ page }, info) => {
  const state = await setup(page);
  await page.getByLabel('문서 질문').fill('과거 가격 정책을 알려줘');
  await page.getByRole('button', { name: '질문 보내기' }).click();
  await expect(page.getByRole('article', { name: 'AI 답변' })).toContainText('초안의 가격은 100원');
  await page.getByRole('button', { name: 'S1 근거 보기' }).click();
  await expect(page.locator('.source-excerpt')).toContainText('<script>alert(1)</script>');
  await expect(page.locator('.chat-source script')).toHaveCount(0);
  expect(await page.locator('.chat-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  await page.screenshot({ path: `/tmp/phase7-chat-${info.project.name}.png` });
  await page.getByRole('button', { name: '인용한 수정 이력 열기' }).click();
  await expect(page.getByRole('dialog', { name: '사업계획서', exact: true })).toBeVisible();
  await expect(page.locator('.cited-block')).toHaveText('초안의 가격은 100원입니다.');
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByLabel('대화 기록').selectOption('session-1');
  await expect(page.getByRole('article', { name: 'AI 답변' })).toContainText('초안의 가격은 100원');
  expect(state.asks).toHaveLength(1);
});

test('viewer asks and searches dates with explicit degraded status', async ({ page }, info) => {
  const state = await setup(page, { viewer: true });
  await expect(page.getByRole('button', { name: '색인 다시 시도' })).toHaveCount(0);
  await page.getByLabel('문서 질문').fill('가격을 알려줘');
  await page.getByRole('button', { name: '질문 보내기' }).click();
  await expect(page.getByRole('article', { name: 'AI 답변' })).toContainText('초안의 가격은 100원');
  await page.getByRole('button', { name: '문서 검색', exact: true }).click();
  await page.getByLabel('검색 범위', { exact: true }).selectOption('as_of');
  await page.getByLabel('기준 날짜').fill('2026-10-01');
  await page.getByLabel('문서 질문').fill('가격 정책');
  await page.getByRole('button', { name: '검색하기' }).click();
  await expect(page.getByText('의미 검색을 사용할 수 없어 텍스트로 검색했습니다.')).toBeVisible();
  await expect(page.getByText('일부 문서의 색인이 완료되지 않아 검색에서 빠질 수 있습니다.')).toBeVisible();
  expect(state.searches[0]).toEqual({ question: '가격 정책', scope: 'as_of', as_of: '2026-10-01' });
  await page.screenshot({ path: `/tmp/phase7-search-${info.project.name}.png` });
});

test('lost response reuses idempotency keys and failed answers can retry', async ({ page }) => {
  const state = await setup(page, { lost: true, failed: true });
  await page.getByLabel('문서 질문').fill('가격 정책');
  await page.getByRole('button', { name: '질문 보내기' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '질문 보내기' }).click();
  await expect(page.getByText('답변의 근거를 검증하지 못했습니다.')).toBeVisible();
  expect(state.creates).toHaveLength(1);
  expect(state.asks).toHaveLength(2);
  expect(state.asks[0].request_id).toBe(state.asks[1].request_id);
  await page.getByRole('button', { name: '답변 다시 시도' }).click();
  await expect(page.getByRole('article', { name: 'AI 답변' })).toContainText('근거 없음');
});


test('chat dock preserves drafts and conversation while folding; compact navigation remains usable', async ({ page }, info) => {
  const state = await setup(page);
  const dock = page.getByRole('complementary', { name: '문서 AI 채팅' });
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByLabel('문서 질문').fill('작성 중인 질문');
  await page.getByRole('button', { name: 'AI 채팅 접기', exact: true }).click();
  await expect(dock).toBeHidden();
  await expect(page.getByRole('button', { name: 'AI 채팅 펼치기' })).toBeFocused();
  await page.getByRole('button', { name: '캔버스 새로고침' }).click();
  const fold = page.getByRole('button', { name: '메뉴 접기', exact: true });
  if (await fold.isVisible()) await fold.click();
  const sidebar = page.getByRole('complementary', { name: '주 메뉴', exact: true });
  expect((await sidebar.boundingBox())!.width).toBeLessThan(80);
  await expect(sidebar.getByRole('button', { name: '문서 관리', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'ConText 홈' })).toBeVisible();
  await expect(sidebar.locator('.brand-logo-symbol')).toBeVisible();
  await expect(sidebar.locator('.brand-logo-full')).toBeHidden();
  await expect.poll(() => sidebar.locator('.brand-logo-symbol img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  await page.getByRole('button', { name: 'AI 채팅 펼치기' }).click();
  await expect(page.getByLabel('문서 질문')).toHaveValue('작성 중인 질문');
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: '캔버스 새로고침' }).click();
    await expect(dock).toBeVisible();
    const main = (await page.locator('.workspace-main').boundingBox())!;
    expect(main.x + main.width).toBeLessThanOrEqual((await dock.boundingBox())!.x);
  }
  await page.getByRole('button', { name: '질문 보내기' }).click();
  await expect(page.getByRole('article', { name: 'AI 답변' })).toContainText('초안의 가격은 100원');
  await page.getByRole('button', { name: 'AI 채팅 접기', exact: true }).click();
  await page.getByRole('button', { name: 'AI 채팅 펼치기' }).click();
  await expect(page.getByRole('article', { name: 'AI 답변' })).toContainText('초안의 가격은 100원');
  expect(state.asks).toHaveLength(1);
  await page.screenshot({ path: `/tmp/context-dock-${info.project.name}.png` });
  await page.getByLabel('문서 질문').press('Escape');
  await expect(dock).toBeHidden();
  await page.getByRole('button', { name: '메뉴 펼치기', exact: true }).click();
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(180);
  await expect(sidebar.locator('.brand .sidebar-label')).toBeVisible();
  await expect(sidebar.locator('.brand-logo-symbol')).toBeHidden();
  await expect.poll(() => sidebar.locator('.brand-logo-full img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await expect(page).toHaveTitle('ConText · 팀 워크스페이스');
  await page.screenshot({ path: `/tmp/context-navigation-${info.project.name}.png` });
});

test('answer references focus the canvas once, and citations refocus without changing the document version', async ({ page }, info) => {
  await setup(page);
  await page.getByLabel('문서 질문').fill('초안 가격');
  await page.getByRole('button', { name: '질문 보내기' }).click();
  const node = page.locator('.react-flow__node[data-id="doc-main"]');
  await expect(node.locator('.paper-reference-badge')).toHaveText('AI 참조 · 이력 1');
  await expect(node.locator('.paper-version')).toContainText('이력 2');
  const centered = async () => {
    const paper = (await node.locator('.paper-sheet').boundingBox())!;
    const area = (await page.locator('.workspace-main').boundingBox())!;
    const sidebar = await page.locator('.sidebar').boundingBox();
    const left = info.project.name === 'mobile' ? 16 : sidebar!.x + sidebar!.width - area.x + 24;
    const top = info.project.name === 'mobile' ? 32 : 180;
    const bottom = info.project.name === 'mobile' ? 40 : 90;
    return Math.abs(paper.x + paper.width / 2 - (area.x + (left + area.width - 24) / 2)) + Math.abs(paper.y + paper.height / 2 - (area.y + (top + area.height - bottom) / 2));
  };
  await expect.poll(centered).toBeLessThan(4);
  if (info.project.name === 'mobile') {
    const paper = (await node.locator('.paper-sheet').boundingBox())!;
    const chat = (await page.locator('.chat-panel').boundingBox())!;
    expect(paper.y + paper.height).toBeLessThan(chat.y);
    await expect(page.locator('.react-flow__controls')).toBeHidden();
  }
  const glow = await node.locator('.paper-reference-glow').elementHandle();
  await page.waitForTimeout(2300); // A message poll must not restart the glow or move the canvas.
  expect(await glow!.evaluate(el => el.isConnected)).toBeTruthy();
  await page.getByRole('button', { name: 'S1 근거 보기' }).click();
  await expect.poll(() => glow!.evaluate(el => el.isConnected)).toBeFalsy();
  await expect.poll(centered).toBeLessThan(4);
  await page.screenshot({ path: `/tmp/context-ai-reference-${info.project.name}.png` });
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(page.locator('.is-ai-reference')).toHaveCount(0);
});

test('search highlights all retrieved files, selects a source, and clears empty results with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  let empty = false;
  await page.route('**/api/workspaces/*/search', route => route.fulfill({ json: { ...evidence, sources: empty ? [] : [source, { ...source, id: 'S2', chunk_id: 'chunk-2', document_id: 'doc-source', document_title: '외부 수정본' }] } }));
  await page.getByRole('button', { name: '문서 검색', exact: true }).click();
  await page.getByLabel('문서 질문').fill('가격');
  await page.getByRole('button', { name: '검색하기' }).click();
  await expect(page.locator('.is-ai-reference')).toHaveCount(2);
  await expect(page.locator('.paper-reference-glow').first()).toHaveCSS('animation-name', 'none');
  await page.locator('.chat-source summary').filter({ hasText: '외부 수정본' }).click();
  await expect(page.locator('.is-ai-reference')).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="doc-source"] .paper-reference-badge')).toBeVisible();
  empty = true;
  await page.getByRole('button', { name: '검색하기' }).click();
  await expect(page.getByText('관련 문서를 찾지 못했습니다. 검색어와 범위를 바꿔 보세요.')).toBeVisible();
  await expect(page.locator('.is-ai-reference')).toHaveCount(0);
});
