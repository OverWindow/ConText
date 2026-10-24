import { expect, test, type Page } from '@playwright/test';
import { prepare } from './version-fixture';

const difference = {
  counts: { added: 0, removed: 0, modified: 1, unchanged: 1 }, total_changes: 1, truncated: false,
  changes: [{ id: 'change-1', kind: 'modified', before: { id: 1, type: 'paragraph', text: '가격 100원', source: { page: 1 } }, after: { id: 1, type: 'paragraph', text: '가격 120원', source: { page: 1 } }, text_diff: [{ kind: 'equal', text: '가격 ' }, { kind: 'removed', text: '100원' }, { kind: 'added', text: '120원' }] }],
};
const completed = { state: 'COMPLETED', finished_at: '2026-10-08T01:00:00Z', result: { warnings: [], provenance: { model: 'gpt-5.6-luna' }, summary: { summary: '가격이 100원에서 120원으로 인상되었습니다.', added: [], removed: [], modified: [{ description: '가격 20원 인상', evidence_ids: ['change-1'] }], partial: false } } };
async function analysisRoutes(page: Page, options: { offline?: boolean; fail?: boolean; partial?: boolean } = {}) {
  let queued = false;
  let failed = options.fail;
  const writes: string[] = [];
  await page.route('http://localhost:3102/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/diff')) {
      if (failed) { await route.fulfill({ status: 503, json: { detail: '차이 분석을 불러오지 못했습니다.' } }); return; }
      await route.fulfill({ json: { ...difference, truncated: !!options.partial } });
    } else if (path.endsWith('/changes')) {
      if (route.request().method() === 'POST') { writes.push(path); queued = true; await route.fulfill({ json: { state: 'QUEUED', result: null } }); return; }
      await route.fulfill({ json: options.offline && !queued ? { state: 'COMPLETED', result: { warnings: ['AI_NOT_CONFIGURED'], summary: null } } : completed });
    } else if (path.endsWith('/intelligence')) {
      await route.fulfill({ json: { analysis: { state: 'COMPLETED', result: { warnings: ['EMBEDDING_NOT_CONFIGURED'], embedding_available: false } }, candidates: { scanned: 2, total: 2, pending: 0, limited: false, items: [{ document_id: 'doc-source', document_title: '외부 수정본', version_id: 'source-v1', version_number: 1, score: 0.88, exact_duplicate: false, filename_similarity: 0.8, text_similarity: 0.9, embedding_similarity: null, sampled: true }] } } });
    } else if (path === '/api/documents/doc-source/versions/link') {
      writes.push(path);
      expect(route.request().postDataJSON().source_version_id).toBe('v2');
      expect(route.request().postDataJSON().request_id).toBeTruthy();
      await route.fulfill({ status: 201, json: {} });
    } else await route.fallback();
  });
  return { writes, recover: () => { failed = false; } };
}

test('text diff, AI summary and source evidence render without page overflow', async ({ page }, info) => {
  await prepare(page);
  await analysisRoutes(page);
  await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
  await page.getByRole('button', { name: '비교하기', exact: true }).click();
  await expect(page.locator('.diff-text del')).toHaveText('100원');
  await expect(page.locator('.diff-text ins')).toHaveText('120원');
  await expect(page.getByRole('article', { name: 'AI 변경 요약' })).toContainText('가격이 100원에서 120원');
  await page.getByRole('article', { name: 'AI 변경 요약' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/phase6-summary-${info.project.name}.png` });
  await page.getByRole('link', { name: '근거 1', exact: true }).click();
  await expect(page.locator('.diff-block')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  expect(await page.locator('.preview-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: `/tmp/phase6-diff-${info.project.name}.png` });
});

test('AI unavailable and truncated diff are explicit; retry restores summary', async ({ page }) => {
  await prepare(page);
  const { writes, recover } = await analysisRoutes(page, { offline: true, partial: true, fail: true });
  await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
  await page.getByRole('button', { name: '비교하기', exact: true }).click();
  await expect(page.getByText('AI 요약 설정이 필요합니다.', { exact: false })).toBeVisible();
  recover();
  await page.getByRole('button', { name: '변경 분석 다시 불러오기' }).click();
  await expect(page.getByText('큰 문서이거나 변경 내용이 많아 일부만 표시합니다.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'AI 요약 요청' }).click();
  await expect(page.getByRole('article', { name: 'AI 변경 요약' })).toBeVisible();
  expect(writes).toEqual(['/api/documents/doc-main/changes']);
});

test('candidate recommendation requires user selection and preserves original/current version', async ({ page }, info) => {
  const state = await prepare(page);
  const { writes } = await analysisRoutes(page);
  await page.getByRole('button', { name: '수정 이력 후보', exact: true }).click();
  await expect(page.getByText('유사도 88%', { exact: true })).toBeVisible();
  await expect(page.getByText('의미 분석 설정이 필요합니다.', { exact: false })).toBeVisible();
  expect(writes).toEqual([]);
  await page.screenshot({ path: `/tmp/phase6-candidates-${info.project.name}.png` });
  await page.getByRole('button', { name: '‘외부 수정본’의 새 수정 이력으로 등록', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '새 수정 이력으로 등록했습니다' })).toBeVisible();
  expect(writes).toEqual(['/api/documents/doc-source/versions/link']);
  expect(state.doc.current_version_id).toBe('v2');
  expect(state.doc.versions).toHaveLength(2);
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await expect(page.locator('.react-flow__node[data-id="doc-main"]')).toBeVisible();
});

test('viewer sees diff and candidates but cannot request or link analyses', async ({ page }) => {
  const state = await prepare(page, 'VIEWER');
  const { writes } = await analysisRoutes(page);
  await page.getByRole('button', { name: '수정 이력 후보', exact: true }).click();
  await expect(page.getByText('유사도 88%', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '후보 분석 요청' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /의 새 수정 이력으로 등록/ })).toHaveCount(0);
  await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
  await page.getByRole('button', { name: '비교하기', exact: true }).click();
  await expect(page.getByRole('article', { name: 'AI 변경 요약' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'AI 요약 요청' })).toHaveCount(0);
  expect(writes).toEqual([]); expect(state.mutations).toEqual([]);
});
