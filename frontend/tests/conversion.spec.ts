import { expect, test, type Page } from '@playwright/test';
import { prepare } from './version-fixture';

type Job = { version_id: string; format: string; state: string; attempts: number; error_message: string | null; size: number | null; warnings: string[] };
async function exportsFixture(page: Page, role = 'OWNER') {
  const jobs: Job[] = [];
  const state = await prepare(page, role, jobs);
  const requests: string[] = [];
  let failNext = false;
  await page.route('http://localhost:3102/api/versions/*/conversions**', async route => {
    const request = route.request();
    const parts = new URL(request.url()).pathname.split('/');
    const version = parts[3], format = parts[5];
    expect(request.headers().authorization).toMatch(/^Bearer /);
    if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { detail: '변환 서비스에 연결하지 못했습니다.' } }); return; }
    if (request.method() === 'GET') { await route.fulfill({ json: jobs.filter(j => j.version_id === version) }); return; }
    requests.push(`${version}/${format}${parts[6] ? '/' + parts[6] : ''}`);
    if (parts[6] === 'download-url') {
      await route.fulfill({ json: { download_url: `http://localhost:3102/storage/export-${version}.${format}` } }); return;
    }
    let job = jobs.find(j => j.version_id === version && j.format === format);
    if (!job) { job = { version_id: version, format, state: 'QUEUED', attempts: 0, error_message: null, size: null, warnings: [] }; jobs.push(job); }
    if (job.state === 'FAILED') { job.state = 'QUEUED'; job.error_message = null; }
    await route.fulfill({ status: 202, json: job });
  });
  await page.route('http://localhost:3102/storage/export-*', async route => {
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({ contentType: 'text/plain', headers: { 'Content-Disposition': 'attachment; filename="export.txt"' }, body: '한글 내보내기 검증' });
  });
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PDF 변환', exact: true })).toBeEnabled();
  return { ...state, jobs, requests, fail: () => { failNext = true; } };
}

test('conversion completes and downloads without sending auth to storage; survives reopen', async ({ page }, info) => {
  const state = await exportsFixture(page);
  await page.getByRole('button', { name: 'PDF 변환', exact: true }).click();
  await expect(page.getByRole('article', { name: 'PDF', exact: true }).getByRole('status')).toHaveText('변환 대기 중');
  await expect(page.getByRole('button', { name: 'PDF 변환', exact: true })).toBeDisabled();
  state.jobs[0].state = 'COMPLETED'; state.jobs[0].size = 2048;
  await expect(page.getByRole('button', { name: 'PDF 다운로드', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('export.txt');
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await page.locator('.react-flow__node[data-id="doc-main"]').click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PDF 다운로드', exact: true })).toBeEnabled();
  expect(state.requests).toEqual(['v2/pdf', 'v2/pdf/download-url']);
  expect(state.doc.current_version_id).toBe('v2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `/tmp/phase8-export-${info.project.name}.png` });
});

test('failed conversion retries and network errors remain actionable', async ({ page }) => {
  const state = await exportsFixture(page);
  await page.getByRole('button', { name: 'Word (DOCX) 변환', exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(1);
  state.jobs[0].state = 'FAILED'; state.jobs[0].error_message = '변환이 중단되었습니다.';
  await expect(page.getByRole('button', { name: 'Word (DOCX) 변환 다시 시도' })).toBeEnabled();
  await page.getByRole('button', { name: 'Word (DOCX) 변환 다시 시도' }).click();
  await expect(page.getByRole('article', { name: 'Word (DOCX)' }).getByRole('status')).toHaveText('변환 대기 중');
  state.fail();
  await page.getByRole('button', { name: 'Markdown 변환', exact: true }).click();
  await expect(page.getByRole('region', { name: '수정 이력 2 내보내기' }).getByRole('alert')).toContainText('변환 서비스에 연결하지 못했습니다.');
  await page.getByRole('button', { name: '상태 다시 확인' }).click();
  await expect(page.getByRole('region', { name: '수정 이력 2 내보내기' }).getByRole('alert')).toHaveCount(0);
  expect(state.requests).toEqual(['v2/docx', 'v2/docx']);
});

test('viewer exports historical version without modifying the current version', async ({ page }) => {
  const state = await exportsFixture(page, 'VIEWER');
  await page.getByRole('button', { name: "수정 이력", exact: true }).click();
  await page.getByRole('button', { name: '수정 이력 1 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByRole('region', { name: '수정 이력 1 내보내기' })).toBeVisible();
  await page.getByRole('button', { name: '텍스트 (TXT) 변환', exact: true }).click();
  await expect.poll(() => state.requests).toEqual(['v1/txt']);
  expect(state.doc.current_version_id).toBe('v2');
  expect(state.mutations).toEqual([]);
});

test('unprocessed version cannot start exports', async ({ page }) => {
  const state = await exportsFixture(page);
  state.doc.versions[1].status = 'PROCESSING';
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await page.locator('.react-flow__node[data-id="doc-main"]').click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByText('문서 처리가 완료되면 변환을 시작할 수 있습니다.')).toBeVisible();
  for (const name of ['PDF', 'Word (DOCX)', '텍스트 (TXT)', 'Markdown']) {
    await expect(page.getByRole('button', { name: `${name} 변환`, exact: true })).toBeDisabled();
  }
  expect(state.requests).toEqual([]);
});

async function openTray(page: Page, mobile: boolean) {
  const card = page.locator('.react-flow__node[data-id="doc-main"]');
  const toggle = card.getByRole('button', { name: '사업계획서 형식 변환', exact: true });
  const tray = card.getByRole('complementary', { name: '사업계획서 형식 변환 패널' });
  if (!mobile) {
    await card.locator('.paper-sheet').hover();
    await expect(toggle).toHaveCSS('opacity', '1');
    await expect(tray).not.toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(10, 10);
    await expect(toggle).toHaveCSS('opacity', '0');
    await card.locator('.paper-sheet').hover();
  }
  await expect(toggle).toHaveCSS('opacity', '1');
  await page.screenshot({ path: `/tmp/canvas-conversion-launcher-${mobile ? 'mobile' : 'desktop'}.png` });
  if (mobile) await toggle.tap();
  else await toggle.click();
  await expect(tray).toBeVisible();
  return { card, tray };
}

test('canvas hover or touch converts, shows version arrows, downloads and restores icons', async ({ page, isMobile }, info) => {
  const state = await exportsFixture(page);
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  const { card, tray } = await openTray(page, isMobile);
  await tray.getByRole('button', { name: 'PDF 변환', exact: true }).click();
  await expect(tray.getByRole('button', { name: 'PDF 변환', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: '사업계획서', exact: true })).toHaveCount(0);
  expect(state.requests).toEqual(['v2/pdf']);
  state.jobs[0].state = 'COMPLETED'; state.jobs[0].size = 2000;
  await expect(tray.getByRole('button', { name: 'PDF 다운로드', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.screenshot({ path: `/tmp/canvas-conversion-tray-${info.project.name}.png` });
  await tray.getByRole('button', { name: '형식 변환 닫기' }).click();
  await page.getByRole('heading', { name: '전략 워크스페이스', exact: true }).click();
  await expect(card.locator('.conversion-summary')).toBeVisible();
  await expect(card.locator('.conversion-results')).toBeHidden();
  await page.screenshot({ path: `/tmp/context-conversion-summary-${info.project.name}.png` });
  if (isMobile) await card.locator('.conversion-summary').tap();
  else await card.locator('.paper-sheet').hover();
  const result = card.getByRole('button', { name: '수정 이력 2 PDF 파일 다운로드' });
  await expect(result).toBeVisible();
  await expect(card.locator('.conversion-results')).toHaveCSS('opacity', '1');
  await expect(card.getByLabel('원본 수정 이력 2에서 변환')).toBeVisible();
  const download = page.waitForEvent('download');
  await result.click();
  expect((await download).suggestedFilename()).toBe('export.txt');
  await expect(tray).not.toBeVisible();
  const paperBounds = (await card.locator('.paper-sheet').boundingBox())!;
  const resultBounds = (await result.boundingBox())!;
  expect(resultBounds.x + resultBounds.width).toBeLessThan(paperBounds.x);
  await page.reload();
  await expect(card.locator('.conversion-summary')).toBeVisible();
  if (isMobile) await card.locator('.conversion-summary').tap();
  else await card.locator('.paper-sheet').hover();
  await expect(page.getByRole('button', { name: '수정 이력 2 PDF 파일 다운로드' })).toBeVisible();
  await expect(card.locator('.conversion-results')).toHaveCSS('opacity', '1');
  await page.waitForTimeout(450);
  await expect(card.locator('.conversion-results')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: `/tmp/canvas-conversion-results-${info.project.name}.png` });
  expect(state.doc.current_version_id).toBe('v2');
  expect(state.mutations).toEqual([]);
});

test('canvas historical conversion retries, handles errors and keeps each version distinct', async ({ page, isMobile }) => {
  const state = await exportsFixture(page, 'VIEWER');
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  const { card, tray } = await openTray(page, isMobile);
  await tray.getByLabel('변환할 원본 수정 이력').selectOption('v1');
  await tray.getByRole('button', { name: 'DOCX 변환', exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(1);
  state.jobs[0].state = 'FAILED'; state.jobs[0].error_message = '변환이 중단되었습니다.';
  await expect(tray.getByRole('button', { name: 'DOCX 변환 다시 시도' })).toBeEnabled({ timeout: 10000 });
  await expect(tray.getByRole('alert')).toContainText('변환이 중단되었습니다.');
  await tray.getByRole('button', { name: 'DOCX 변환 다시 시도' }).click();
  state.jobs[0].state = 'COMPLETED';
  await expect(tray.getByRole('button', { name: 'DOCX 다운로드', exact: true })).toBeEnabled({ timeout: 10000 });
  await tray.getByLabel('변환할 원본 수정 이력').selectOption('v2');
  await expect(tray.getByRole('button', { name: 'DOCX 변환', exact: true })).toBeEnabled();
  state.fail();
  await tray.getByRole('button', { name: 'PDF 변환', exact: true }).click();
  await expect(tray.getByRole('alert')).toContainText('변환 서비스에 연결하지 못했습니다.');
  await tray.getByRole('button', { name: 'PDF 변환', exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(2);
  state.jobs[1].state = 'COMPLETED';
  await expect(tray.getByRole('button', { name: 'PDF 다운로드', exact: true })).toBeEnabled({ timeout: 10000 });
  await tray.getByRole('button', { name: '형식 변환 닫기' }).click();
  await page.getByRole('heading', { name: '전략 워크스페이스', exact: true }).click();
  if (isMobile) await card.locator('.conversion-summary').tap();
  else await card.locator('.paper-sheet').hover();
  await expect(card.getByRole('button', { name: '수정 이력 1 DOCX 파일 다운로드' })).toBeVisible();
  await expect(card.getByRole('button', { name: '수정 이력 2 PDF 파일 다운로드' })).toBeVisible();
  expect(state.requests).toEqual(['v1/docx', 'v1/docx', 'v2/pdf']);
  expect(state.doc.current_version_id).toBe('v2');
  expect(state.mutations).toEqual([]);
});

test('canvas keyboard tray closes with escape and unprocessed files disable conversions', async ({ page }) => {
  const state = await exportsFixture(page);
  state.doc.versions[1].status = 'PROCESSING';
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await expect(page.locator('.react-flow__node[data-id="doc-main"] .canvas-file-status')).toContainText('문서 분석 중');
  const toggle = page.getByRole('button', { name: '사업계획서 형식 변환', exact: true });
  await toggle.focus();
  await expect(toggle).toBeFocused();
  const tray = page.getByRole('complementary', { name: '사업계획서 형식 변환 패널' });
  await expect(tray).not.toBeVisible();
  await toggle.press('Enter');
  await expect(tray.getByText('문서 처리 완료 후 변환할 수 있습니다.')).toBeVisible();
  for (const format of ['PDF', 'DOCX', 'TXT', 'Markdown']) await expect(tray.getByRole('button', { name: `${format} 변환`, exact: true })).toBeDisabled();
  await tray.getByRole('button', { name: '형식 변환 닫기' }).press('Escape');
  await expect(tray).not.toBeVisible();
  await expect(toggle).toBeFocused();
  expect(state.requests).toEqual([]);
});

test('copy action creates a separate file beside the original, opens its content and persists on reload', async ({ page, isMobile }) => {
  const state = await exportsFixture(page);
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  let copied: typeof state.doc | null = null;
  let position = { x: 0, y: 0 };
  let requests = 0;
  let saved: { document_id: string; x: number; y: number }[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/documents/doc-main/copy')) {
      requests++;
      const data = route.request().postDataJSON();
      expect(data.version_id).toBe('v2');
      expect(data.request_id).toBeTruthy();
      position = { x: data.x, y: data.y };
      copied = { ...state.doc, id: 'doc-copy', title: '사업계획서 copy', current_version_id: 'copy-v1', versions: [{ ...state.doc.versions[1], id: 'copy-v1', document_id: 'doc-copy', version_number: 1, original_filename: '사업계획-2 copy.md' }] };
      await route.fulfill({ status: 201, json: { document: copied, ...position } });
    } else if (path.endsWith('/canvas/positions')) {
      saved = route.request().postDataJSON().positions;
      const moved = saved.find(p => p.document_id === copied?.id); if (moved) position = moved;
      await route.fulfill({ json: saved });
    } else if (copied && path.endsWith('/documents/doc-copy')) await route.fulfill({ json: copied });
    else if (copied && path.endsWith('/canvas')) await route.fulfill({ json: { documents: [state.doc, copied], positions: saved.length ? saved : [{ document_id: copied.id, ...position }], relations: [], conversions: [] } });
    else await route.fallback();
  });
  const original = page.locator('.react-flow__node[data-id="doc-main"]');
  if (!isMobile) await original.locator('.paper-sheet').hover();
  await expect(original.locator(".document-copy-toggle")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: `/tmp/context-copy-menu-${isMobile ? 'mobile' : 'desktop'}.png` });
  await original.getByRole('button', { name: '사업계획서 복사본 생성하기' }).click();
  const copy = page.locator('.react-flow__node[data-id="doc-copy"]');
  await expect(copy.locator('.paper-caption')).toHaveText('사업계획-2 copy.md');
  await expect(original.locator('.paper-caption')).toHaveText('사업계획-2.md');
  expect(requests).toBe(1);
  expect(position.x).not.toBe(0);
  await copy.locator('.paper-sheet').click();
  await expect(page.getByRole('dialog', { name: '사업계획서 copy', exact: true })).toBeVisible();
  await expect(page.getByText('수정된 가격은 120원입니다.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(copy.locator('.paper-caption')).toHaveText('사업계획-2 copy.md');
});

test('hover stays connected across the gap and both actions, with a forgiving exit delay', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Touch uses directly visible actions');
  await exportsFixture(page);
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  const card = page.locator('.react-flow__node[data-id="doc-main"]');
  const convert = card.getByRole('button', { name: '사업계획서 형식 변환', exact: true });
  const copy = card.getByRole('button', { name: '사업계획서 복사본 생성하기' });
  await card.locator('.paper-sheet').hover();
  await expect(convert).toHaveCSS('opacity', '1');
  const paper = (await card.locator('.paper-sheet').boundingBox())!;
  const zoom = paper.width / 200;
  // Pause between the file and the gap between the two circular buttons.
  await page.mouse.move(paper.x + paper.width + 6 * zoom, paper.y + 53 * zoom, { steps: 8 });
  await page.waitForTimeout(500);
  await expect(copy).toHaveCSS('opacity', '1');
  const copyBounds = (await copy.boundingBox())!;
  await page.mouse.move(copyBounds.x + copyBounds.width / 2, copyBounds.y + copyBounds.height / 2, { steps: 8 });
  await page.waitForTimeout(400);
  await expect(convert).toHaveCSS('opacity', '1');
  await page.mouse.move(10, 10);
  await page.waitForTimeout(100);
  await expect(copy).toHaveCSS('opacity', '1');
  await expect(copy).toHaveCSS('opacity', '0');
  await card.locator('.paper-sheet').hover();
  await convert.click();
  await expect(card.getByRole('complementary', { name: '사업계획서 형식 변환 패널' })).toBeVisible();
});
