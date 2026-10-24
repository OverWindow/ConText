import { expect, test, type Page } from '@playwright/test';
import { prepare } from './version-fixture';
import type { WritingContent, WritingDraft } from '../features/writing/types';

const content: WritingContent = {
  title: '프로젝트 소개서',
  blocks: [
    { id: 'intro', type: 'heading', text: '추진 배경', level: 2, items: [], rows: [], source_ids: [] },
    { id: 'body', type: 'paragraph', text: '자료를 찾아 문서를 작성합니다. <script>alert(1)</script>', level: 2, items: [], rows: [], source_ids: ['note-1'] },
    { id: 'list', type: 'list', text: '', level: 2, items: ['자료 검색', '문서 작성'], rows: [], source_ids: [] },
    { id: 'table', type: 'table', text: '', level: 2, items: [], rows: [['항목', '상태'], ['예산', '확인 필요']], source_ids: [] },
  ],
};
const initial: WritingDraft = {
  id: 'draft-1', title: content.title, content, revision: 1, can_undo: false, proposal: null,
  sources: [{ id: 'note-1', kind: 'note', document_title: '캔버스 메모', text: '문서 자동화 프로젝트 <script>alert(1)</script>' }],
  checks: ['예산을 확인해 주세요.'],
};

async function setup(page: Page, options: { viewer?: boolean; lost?: boolean; deleteConflict?: boolean } = {}) {
  await prepare(page, options.viewer ? 'VIEWER' : 'OWNER');
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  const draft = structuredClone(initial);
  let exists = !!options.viewer;
  let lost = options.lost;
  const requests: Record<string, unknown>[] = [];
  const saved: WritingContent[] = [];
  const history: WritingContent[] = [];
  const deletes: string[] = [];
  await page.route('**/api/workspaces/*/writing**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    expect(request.headers().authorization).toMatch(/^Bearer /);
    if (request.method() === 'DELETE') {
      deletes.push(url.searchParams.get('revision')!);
      if (options.deleteConflict) { await route.fulfill({ status: 409, json: { detail: '다른 곳에서 문서가 변경됐습니다. 저장된 문서를 다시 열어 주세요.' } }); return; }
      expect(url.searchParams.get('revision')).toBe(String(draft.revision));
      exists = false; await route.fulfill({ status: 204 }); return;
    }
    if (path.includes('/export/')) {
      expect(url.searchParams.get('revision')).toBe(String(draft.revision));
      await route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from('verified separately by backend roundtrip tests') }); return;
    }
    if (path.endsWith('/writing')) {
      if (request.method() === 'GET') { await route.fulfill({ json: exists ? [{ id: draft.id, title: draft.title }] : [] }); return; }
      requests.push(request.postDataJSON()); exists = true;
      if (lost) { lost = false; await route.abort('failed'); return; }
    } else if (request.method() === 'PATCH') {
      const body = request.postDataJSON(); expect(body.revision).toBe(draft.revision);
      history.push(draft.content); draft.content = body.content; draft.title = body.content.title; draft.revision++; draft.can_undo = true; saved.push(body.content);
    } else if (path.endsWith('/propose')) {
      const body = request.postDataJSON(); expect(body.revision).toBe(draft.revision);
      requests.push(body); draft.proposal = { content: { ...draft.content, title: '수정된 소개서' }, sources: draft.sources, checks: ['추가 확인'] }; draft.revision++;
    } else if (path.endsWith('/accept')) {
      history.push(draft.content); draft.content = draft.proposal!.content; draft.title = draft.content.title; draft.proposal = null; draft.revision++; draft.can_undo = true;
    } else if (path.endsWith('/reject')) {
      draft.proposal = null; draft.revision++;
    } else if (path.endsWith('/undo')) {
      draft.content = history.pop()!; draft.title = draft.content.title; draft.revision++; draft.can_undo = !!history.length;
    }
    await route.fulfill({ json: draft });
  });
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'AI 문서 작성', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'AI 문서 작성', exact: true })).toBeVisible();
  return { requests, saved, deletes };
}

async function generate(page: Page) {
  await page.getByLabel('어떤 문서를 만들까요?').fill('프로젝트 자료로 소개서를 작성해줘');
  await page.getByRole('button', { name: 'AI 초안 만들기' }).click();
  await expect(page.locator('.writing-editor .ce-paragraph')).toContainText('자료를 찾아');
  await expect(page.getByText('저장됨 · 버전 1', { exact: true })).toBeVisible();
}

test('automatic draft, Korean block editing, evidence, reviewed AI changes and exports', async ({ page }, info) => {
  const state = await setup(page);
  await generate(page);
  await expect(page.locator('.writing-editor script')).toHaveCount(0);
  await expect(page.locator('.writing-editor .tc-cell').first()).toHaveText('항목');
  const paragraph = page.locator('.writing-editor .ce-paragraph');
  await paragraph.click();
  await expect(page.getByRole('heading', { name: '선택한 문단의 출처' })).toBeVisible();
  await page.getByText('캔버스 메모', { exact: true }).click();
  await expect(page.locator('.writing-context details p')).toContainText('<script>alert(1)</script>');
  await paragraph.fill('직접 수정한 한글 본문');
  await expect(page.getByText('저장하지 않은 변경', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장됨 · 버전 2', { exact: true })).toBeVisible();
  expect(state.saved[0].blocks.find(b => b.id === 'body')).toMatchObject({ text: '직접 수정한 한글 본문', source_ids: ['note-1'] });
  await page.getByLabel('이 문서를 어떻게 수정할까요?').fill('제목을 수정해줘');
  await page.getByRole('button', { name: 'AI 수정안 만들기' }).click();
  await expect(page.getByRole('region', { name: 'AI 수정안 검토' })).toBeVisible();
  await page.getByText('수정안에서 참고한 원문', { exact: true }).click();
  await expect(page.locator('.writing-proposal-sources p')).toContainText('문서 자동화 프로젝트');
  await expect(page.getByLabel('문서 제목')).toHaveValue('프로젝트 소개서');
  await expect(paragraph).toHaveText('직접 수정한 한글 본문');
  await expect(page.locator('.writing-editor .ce-block').first()).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: '수정안 적용' }).click();
  await expect(page.getByLabel('문서 제목')).toHaveValue('수정된 소개서');
  await expect(paragraph).toHaveText('직접 수정한 한글 본문');
  for (const format of ['DOCX', 'HWPX']) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: format, exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe(`수정된 소개서.${format.toLowerCase()}`);
  }
  await page.getByRole('dialog', { name: 'AI 문서 작성', exact: true }).getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(page.getByLabel('문서 제목')).toHaveValue('프로젝트 소개서');
  await expect(paragraph).toHaveText('직접 수정한 한글 본문');
  await expect(page.locator('.writing-editor .ce-block').first()).toHaveCSS('opacity', '1');
  expect(await page.locator('.writing-studio').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `/private/tmp/context-writing-${info.project.name}.png` });
  await page.getByRole('button', { name: '문서 작성 닫기' }).click();
});

test('lost response retry retains request ID; unsaved edits require deliberate discard', async ({ page }) => {
  const state = await setup(page, { lost: true });
  await page.getByLabel('어떤 문서를 만들까요?').fill('프로젝트 소개서를 작성해줘');
  await page.getByRole('button', { name: 'AI 초안 만들기' }).click();
  await expect(page.locator('.writing-error')).toBeVisible();
  await page.getByRole('button', { name: 'AI 초안 만들기' }).click();
  await expect(page.locator('.writing-editor .ce-paragraph')).toBeVisible();
  expect(state.requests[0].request_id).toBe(state.requests[1].request_id);
  await page.getByLabel('문서 제목').fill('미저장 제목');
  await page.getByRole('button', { name: '새 문서', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '계속 편집' }).click();
  await expect(page.getByLabel('문서 제목')).toHaveValue('미저장 제목');
  await page.getByRole('button', { name: '새 문서', exact: true }).click();
  await page.getByRole('button', { name: '변경 버리고 이동' }).click();
  await expect(page.getByLabel('어떤 문서를 만들까요?')).toBeVisible();
  await page.getByRole('button', { name: '문서 작성 닫기' }).click();
  await expect(page.getByRole('dialog', { name: 'AI 문서 작성', exact: true })).toHaveCount(0);
});

test('viewers can read and export but cannot edit', async ({ page }) => {
  await setup(page, { viewer: true });
  await page.getByRole('button', { name: '프로젝트 소개서', exact: true }).click();
  await expect(page.locator('.writing-editor .ce-paragraph')).toBeVisible();
  await expect(page.getByLabel('문서 제목')).toHaveAttribute('readonly');
  await expect(page.locator('.writing-editor [contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새 문서', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'DOCX', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '문서 삭제', exact: true })).toHaveCount(0);
});

test('delete confirms the document, supports cancel and discards only after success', async ({ page }) => {
  const state = await setup(page);
  await generate(page);
  await page.getByLabel('문서 제목').fill('미저장 제목');
  await page.getByRole('button', { name: '문서 삭제', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '문서를 삭제할까요?' });
  await expect(confirm).toContainText('프로젝트 소개서');
  await expect(confirm).toContainText('저장하지 않은 변경도 함께 버립니다.');
  await expect(confirm.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(page.getByLabel('문서 제목')).toHaveValue('미저장 제목');
  expect(state.deletes).toHaveLength(0);
  await page.getByRole('button', { name: '문서 삭제', exact: true }).click();
  await confirm.getByRole('button', { name: '삭제하기', exact: true }).click();
  await expect(page.getByLabel('어떤 문서를 만들까요?')).toBeVisible();
  await expect(page.getByRole('complementary', { name: '작성한 문서' }).getByRole('button', { name: '프로젝트 소개서', exact: true })).toHaveCount(0);
  expect(state.deletes).toEqual(['1']);
  expect(state.saved).toHaveLength(0);
  await page.getByRole('button', { name: '문서 작성 닫기' }).click();
  await expect(page.getByRole('dialog', { name: 'AI 문서 작성', exact: true })).toHaveCount(0);
});

test('a deletion conflict keeps the document and unsaved edits', async ({ page }) => {
  await setup(page, { deleteConflict: true });
  await generate(page);
  await page.getByLabel('문서 제목').fill('보존할 제목');
  await page.getByRole('button', { name: '문서 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제하기', exact: true }).click();
  await expect(page.locator('.writing-error')).toContainText('다른 곳에서 문서가 변경됐습니다');
  await expect(page.getByLabel('문서 제목')).toHaveValue('보존할 제목');
  await expect(page.getByText('저장하지 않은 변경', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '문서 삭제', exact: true })).toBeEnabled();
});
