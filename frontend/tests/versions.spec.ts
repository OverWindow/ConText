import { expect, test } from '@playwright/test';
import { prepare, newBody } from './version-fixture';

test('timeline selects historical text and current version survives reload', async ({ page }, testInfo) => {
  const state = await prepare(page);
  await page.getByRole('button', { name: "수정 이력", exact: true }).click();
  await expect(page.getByText('가격 정책 수정', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '수정 이력 1을 현재 수정 이력으로 지정', exact: true }).click();
  await expect.poll(() => state.doc.current_version_id).toBe('v1');
  await page.getByRole('button', { name: '수정 이력 1 미리보기', exact: true }).click();
  await expect(page.getByText('초안의 가격은 100원입니다.')).toBeVisible();
  await page.reload();
  await page.locator('.react-flow__node[data-id="doc-main"]').click();
  await expect(page.getByText('초안의 가격은 100원입니다.')).toBeVisible();
  await page.getByRole('button', { name: "수정 이력", exact: true }).click();
  await page.screenshot({ path: `/tmp/phase5-timeline-${testInfo.project.name}.png` });
});

test('new version upload and verification retry preserve current version', async ({ page }) => {
  const state = await prepare(page); state.failCompletion();
  await page.getByRole('button', { name: '새 수정 이력', exact: true }).click();
  await page.getByLabel('수정 이력 파일', { exact: true }).setInputFiles({ name: '수정본.txt', mimeType: 'text/plain', buffer: newBody });
  await page.getByLabel('등록 메모 (선택)').fill('수정 메모');
  await page.getByRole('button', { name: '새 수정 이력 올리기', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '업로드 검증' })).toBeVisible();
  expect(state.uploaded()).toBeTruthy(); expect(state.doc.current_version_id).toBe('v2');
  await page.getByRole('button', { name: "수정 이력", exact: true }).click();
  await page.getByRole('button', { name: '업로드 완료 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '수정 이력 3을 현재 수정 이력으로 지정' })).toBeVisible();
  expect(state.doc.current_version_id).toBe('v2'); expect(state.doc.versions).toHaveLength(3);
});

test('manual linking keeps source document and adds provenance', async ({ page }) => {
  const state = await prepare(page);
  await page.getByRole('button', { name: '새 수정 이력', exact: true }).click();
  await page.getByRole('button', { name: '기존 수정 이력 연결', exact: true }).click();
  await page.getByLabel('원본 문서', { exact: true }).selectOption('doc-source');
  await page.getByLabel('원본 수정 이력', { exact: true }).selectOption('source-v1');
  await page.getByLabel('등록 메모 (선택)').fill('외부 수정본 연결');
  await page.getByRole('button', { name: '이 문서의 수정 이력으로 연결', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '새 수정 이력으로 연결' })).toBeVisible();
  await page.getByRole('button', { name: "수정 이력", exact: true }).click();
  await expect(page.getByText('다른 문서의 수정 이력에서 연결됨', { exact: true })).toBeVisible();
  expect(state.doc.current_version_id).toBe('v2');
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await expect(page.locator('.react-flow__node[data-id="doc-source"]')).toBeVisible();
});

test('comparison reads both texts and viewer cannot mutate versions', async ({ page }, testInfo) => {
  const state = await prepare(page, 'VIEWER');
  await expect(page.getByRole('button', { name: '새 수정 이력', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: "수정 이력", exact: true }).click();
  await expect(page.getByRole('button', { name: /현재 수정 이력으로 지정/ })).toHaveCount(0);
  await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
  await page.getByRole('button', { name: '비교하기', exact: true }).click();
  await expect(page.getByText('두 수정 이력의 파일 내용이 다릅니다.')).toBeVisible();
  await expect(page.getByText('초안의 가격은 100원입니다.')).toBeVisible();
  await expect(page.getByText('수정된 가격은 120원입니다.')).toBeVisible();
  expect(state.mutations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  await page.screenshot({ path: `/tmp/phase5-compare-${testInfo.project.name}.png` });
});

test('duplicate detection pauses a new-document upload until explicitly acknowledged', async ({ page }) => {
  const state = await prepare(page); state.duplicate();
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await page.getByLabel('빠른 파일 선택', { exact: true }).setInputFiles({ name: '수정본.txt', mimeType: 'text/plain', buffer: newBody });
  await page.getByRole('button', { name: '문서 올리기', exact: true }).click();
  await expect(page.getByText('동일한 파일이 이미 있습니다.', { exact: true })).toBeVisible();
  expect(state.mutations).toEqual([]); expect(state.uploaded()).toBeFalsy();
  await page.getByLabel('중복을 확인했으며 별도 문서로 등록합니다.').check();
  await page.getByRole('button', { name: '문서 올리기', exact: true }).click();
  await expect.poll(() => state.uploaded()).toBeTruthy();
});
