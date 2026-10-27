import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Only the paid model boundary is replaced; parsing, retrieval, persistence, IPC and UI stay real.
async function installSyntheticAI(app: ElectronApplication) {
    await app.evaluate(async ({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { AIConnections } = require(app.getAppPath() + '/electron/ai-connections.mjs');
      AIConnections.prototype.ensureReady = async () => {};
      AIConnections.prototype.generate = async function(request: any) {
        const source = request.sources.find((source: any) => source.text.includes('100만원')) || request.sources[0];
        if (request.task === 'summary') return { claims: [{ text: '예산이 100만원에서 200만원으로 변경됐습니다.', source_ids: [source.id] }], insufficient: false };
        return request.task === 'write' ? { content: { title: '선택 자료 요약', blocks: [{ id: 'p', type: 'paragraph', text: '선택한 자료의 한글 요약입니다.', source_ids: [source.id] }] }, checks: [] }
          : { claims: [{ text: '예산은 100만원입니다.', source_ids: [source.id] }], insufficient: false };
      };
    });
}

test('shared editor creates a local draft, exports a real DOCX and restores after restart', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-writing-e2e-'));
  const root = path.join(base, '내 자료'); await mkdir(root);
  const original = path.join(root, '근거.md'); await writeFile(original, '# 원본\n수정하지 않는 자료');
  const output = path.join(root, '작성 문서.docx');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.getByRole('button', { name: 'AI 문서 작성', exact: true }).click();
    await page.getByRole('button', { name: '직접 작성하기' }).click();
    await page.getByRole('textbox', { name: '문서 제목' }).fill('밤샘 작성 문서');
    await expect(page.locator('.ce-paragraph[contenteditable="true"]')).toBeVisible();
    await page.locator('.ce-paragraph[contenteditable="true"]').fill('같은 편집기로 로컬에서 저장한 한글 본문입니다.');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.locator('.writing-actions')).toContainText('저장됨 · 버전 2');
    await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, output);
    await page.getByRole('button', { name: 'DOCX', exact: true }).click();
    await expect.poll(async () => { try { return (await readFile(output)).subarray(0, 2).toString(); } catch { return ''; } }).toBe('PK');
    await page.getByRole('button', { name: '문서 작성 닫기' }).click();
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: 'AI 문서 작성', exact: true }).click();
    await page.getByRole('button', { name: '밤샘 작성 문서', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목' })).toHaveValue('밤샘 작성 문서');
    await expect(page.locator('.ce-paragraph')).toContainText('같은 편집기로 로컬에서 저장한 한글 본문');
    await page.screenshot({ path: 'test-results/desktop-writing.png' });
    expect(await readFile(original, 'utf8')).toBe('# 원본\n수정하지 않는 자료');
    expect(errors).toEqual([]);
    const sources = await page.evaluate(async () => {
      const api = window.contextDesktop;
      const workspace = (await api.list())[0];
      const file = (await api.snapshot(workspace.id)).entries.find(entry => entry.name === '근거.md')!;
      await api.openDocument(workspace.id, file.id);
      return api.searchContent(workspace.id, '수정하지');
    });
    expect(sources[0].text).toContain('수정하지 않는 자료');
    await page.getByRole('button', { name: '문서 작성 닫기' }).click();
    await expect(page.getByRole('dialog', { name: 'AI 문서 작성', exact: true })).toHaveCount(0);
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('local content search opens a cited snapshot and shared history compares and restores the original', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-history-e2e-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const filename = path.join(root, '가격.md'); await writeFile(filename, '# 가격 정책\n예산은 100만원입니다.');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.getByTestId('file-가격.md').locator('.paper-caption').dblclick();
    await expect(page.locator('.context-document-preview .text-block')).toContainText(['가격 정책', '100만원']);
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    await writeFile(filename, '# 가격 정책\n예산은 200만원입니다.');
    await expect.poll(() => page.evaluate(async () => {
      const api = window.contextDesktop, workspace = (await api.list())[0];
      const entry = (await api.snapshot(workspace.id)).entries.find(entry => entry.name === '가격.md')!;
      return (await api.getDocument(workspace.id, entry.id)).versions.length;
    })).toBe(2);
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    const search = page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' });
    await search.getByRole('button', { name: '검색 설정', exact: true }).click();
    await search.getByRole('textbox', { name: '문서 질문' }).fill('100만원');
    await search.getByLabel('검색 범위').selectOption('history');
    await search.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(search.locator('.chat-source')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '문서 검색', exact: true })).toHaveCount(0);
    await search.getByLabel('참조한 내용 더 보기', { exact: true }).click();
    await search.locator('.chat-source summary').click();
    await search.getByRole('button', { name: '인용한 수정 이력 열기' }).click();
    await expect(page.locator('.context-document-preview .cited-block')).toContainText('100만원');
    await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
    await page.getByRole('button', { name: '비교하기', exact: true }).click();
    await expect(page.locator('.diff-text ins')).toContainText('200만원');
    await expect(page.locator('.diff-text del')).toContainText('100만원');
    await page.getByRole('button', { name: '수정 이력', exact: true }).click();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.getByRole('button', { name: '수정 이력 1을 원본 복원', exact: true }).click();
    await expect.poll(() => readFile(filename, 'utf8')).toContain('100만원');
    await expect(page.getByRole('region', { name: '수정 이력 타임라인' })).toContainText('3개');
    await page.screenshot({ path: 'test-results/desktop-version-history.png' });
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('UTF-8 file editing saves revisions, rejects external conflicts and supports native rename', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-file-edit-e2e-'));
  const root = path.join(base, '한글 폴더'); await mkdir(root);
  const filename = path.join(root, '직접.md'); await writeFile(filename, '# 원본\n기존 본문');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.getByTestId('file-직접.md').locator('.paper-caption').dblclick();
    await page.getByRole('button', { name: '텍스트 편집', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '텍스트 편집 · 직접.md', exact: true });
    await editor.getByRole('textbox', { name: '원본 텍스트' }).fill('# 원본\n저장한 한글 본문');
    await editor.getByRole('button', { name: '원본 저장', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('저장됨');
    expect(await readFile(filename, 'utf8')).toContain('저장한 한글 본문');
    await editor.getByRole('textbox', { name: '원본 텍스트' }).fill('보존할 편집안');
    await writeFile(filename, '외부 앱의 수정');
    await editor.getByRole('button', { name: '원본 저장', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('외부에서 파일이 변경');
    await expect(editor.getByRole('textbox', { name: '원본 텍스트' })).toHaveValue('보존할 편집안');
    expect(await readFile(filename, 'utf8')).toBe('외부 앱의 수정');
    await editor.getByRole('button', { name: '텍스트 편집 닫기' }).click();
    await editor.getByRole('button', { name: '변경 버리기' }).click();
    await page.getByRole('button', { name: '이름 변경', exact: true }).click();
    await page.getByRole('textbox', { name: '새 파일 이름', exact: true }).fill('이름 변경.md');
    await page.getByRole('button', { name: '이름 저장', exact: true }).click();
    await expect(page.getByTestId('file-이름 변경.md')).toBeVisible();
    expect(await readFile(path.join(root, '이름 변경.md'), 'utf8')).toBe('외부 앱의 수정');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('shared canvas tools persist notes, folder geometry and source relations with undo and redo', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-canvas-e2e-'));
  const root = path.join(base, '생각 자료'); await mkdir(root);
  await writeFile(path.join(root, 'A.md'), '# 기획\n첫 자료'); await writeFile(path.join(root, 'B.md'), '# 근거\n둘째 자료');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const first = page.getByTestId('file-A.md').locator('.react-flow__handle[data-handleid="right"]');
    const second = page.getByTestId('file-B.md').locator('.react-flow__handle[data-handleid="left"]');
    const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 }); await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    const bottom = (await page.getByTestId('file-A.md').locator('.react-flow__handle[data-handleid="bottom"]').boundingBox())!;
    const top = (await page.getByTestId('file-B.md').locator('.react-flow__handle[data-handleid="top"]').boundingBox())!;
    await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2); await page.mouse.down();
    await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2, { steps: 12 }); await page.mouse.up();
    const direction = () => page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; return (await api.canvasSnapshot(ws.id, '')).relations[0].source_handle; });
    await expect.poll(direction).toBe('bottom');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(direction).toBe('right');
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect.poll(direction).toBe('bottom');
    await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
    await page.getByRole('textbox', { name: '캔버스 텍스트 내용' }).fill('웹과 같은 캔버스 메모');
    await page.getByLabel('글자 크기', { exact: true }).selectOption('32');
    await page.getByRole('button', { name: '파랑 색상' }).click();
    await expect(page.getByRole('status')).toContainText('텍스트·도형 저장됨');
    await page.getByRole('button', { name: '사각형 폴더 추가', exact: true }).click();
    await page.getByRole('textbox', { name: '폴더 이름 편집', exact: true }).fill('연결한 생각');
    await page.getByRole('spinbutton', { name: '요소 너비', exact: true }).fill('800');
    await expect(page.getByRole('status')).toContainText('텍스트·도형 저장됨');
    await page.getByRole('button', { name: '캔버스 수정 완료', exact: true }).click();
    await page.screenshot({ path: 'test-results/desktop-shared-canvas.png' });
    expect(errors).toEqual([]);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.decoration-text-content')).toContainText('웹과 같은 캔버스 메모');
    await expect(page.locator('.decoration-text-content')).toHaveCSS('font-size', '32px');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.getByText('연결한 생각', { exact: true })).toBeVisible();
    const state = await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; return api.canvasSnapshot(ws.id, ''); });
    expect(state.elements.find(e => e.kind === 'rectangle')?.width).toBe(800);
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('local selection summary and chat share the web UI, preserve sources and restore conversations', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-ai-ui-e2e-'));
  const root = path.join(base, '자료'); await mkdir(root);
  await writeFile(path.join(root, '예산.md'), '# 예산\n예산은 100만원입니다.'); await writeFile(path.join(root, '일정.md'), '# 일정\n일정은 10월입니다.');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    await installSyntheticAI(app);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const a = (await page.getByTestId('file-예산.md').boundingBox())!, b = (await page.getByTestId('file-일정.md').boundingBox())!;
    await page.getByRole('button', { name: '영역 선택', exact: true }).click();
    await page.mouse.move(Math.min(a.x, b.x) - 8, Math.min(a.y, b.y) - 8); await page.mouse.down();
    await page.mouse.move(Math.max(a.x + a.width, b.x + b.width) + 8, Math.max(a.y + a.height, b.y + b.height) + 8, { steps: 12 }); await page.mouse.up();
    await expect(page.getByRole('region', { name: '선택한 파일 작업' })).toContainText('2개 파일 선택');
    // A summary and its edges can arrive before the new card's resize notification.
    const resumeResize = await page.evaluateHandle(() => {
      const observe = ResizeObserver.prototype.observe;
      ResizeObserver.prototype.observe = function(target, options) {
        if (!target.classList.contains('react-flow__node-file')) observe.call(this, target, options);
      };
      return () => { ResizeObserver.prototype.observe = observe; };
    });
    try {
      await page.getByRole('button', { name: '요약 파일 만들기', exact: true }).click();
      await expect(page.getByRole('dialog').filter({ has: page.getByText('선택한 자료의 한글 요약입니다.', { exact: true }) })).toBeVisible();
      await page.getByRole('button', { name: '미리보기 닫기' }).click();
      await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    } finally { await resumeResize.evaluate(resume => resume()); await resumeResize.dispose(); }
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    const chat = page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' });
    const viewport = page.locator('.react-flow__viewport'), beforeView = await viewport.getAttribute('style');
    const neighbor = await page.getByTestId('file-일정.md').elementHandle();
    const geometry = () => page.getByTestId('file-예산.md').evaluate(node => { const card = node.closest<HTMLElement>('.react-flow__node')!; return { position: card.style.transform, width: card.style.width, height: card.style.height }; });
    const beforeGeometry = await geometry();
    const savedView = await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; return (await api.snapshot(ws.id)).views; });
    await chat.getByRole('textbox', { name: '문서 질문' }).fill('예산');
    await chat.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(chat.locator('.chat-claim')).toContainText('100만원');
    await expect(page.getByTestId('file-예산.md')).toHaveClass(/is-ai-reference/);
    await expect.poll(() => geometry()).toEqual(beforeGeometry);
    expect(await neighbor!.evaluate(node => node.isConnected)).toBeTruthy();
    await expect(page.getByTestId('file-일정.md')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    await expect(viewport).not.toHaveAttribute('style', beforeView!);
    const centered = async () => { const card = (await page.getByTestId('file-예산.md').boundingBox())!, area = (await page.locator('.canvas-area').boundingBox())!; return Math.abs(card.x + card.width / 2 - area.x - area.width / 2); };
    await expect.poll(centered).toBeLessThan(2);
    let lastView = ''; await expect.poll(async () => { const value = (await viewport.getAttribute('style'))!; const same = value === lastView; lastView = value; return same; }).toBeTruthy();
    await expect(chat.locator('.chat-sources')).not.toHaveAttribute('open');
    await expect(chat.locator('.chat-source summary').first()).toBeHidden();
    const focusedView = await viewport.getAttribute('style');
    await page.screenshot({ path: 'test-results/desktop-reference-collapsed.png' });
    await chat.getByLabel('참조한 내용 더 보기', { exact: true }).click();
    await expect(chat.locator('.chat-source summary').first()).toBeVisible();
    await expect(viewport).toHaveAttribute('style', focusedView!);
    await page.screenshot({ path: 'test-results/desktop-reference-expanded.png' });
    await chat.getByLabel('참조한 내용 접기', { exact: true }).click();
    await expect(viewport).toHaveAttribute('style', focusedView!);
    const currentView = await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; return (await api.snapshot(ws.id)).views; });
    expect(currentView).toEqual(savedView);
    await page.getByRole('button', { name: '참조 보기 종료', exact: true }).click();
    await expect(viewport).toHaveAttribute('style', beforeView!);

    await chat.locator('.citation').first().click();
    await chat.getByRole('button', { name: '인용한 수정 이력 열기' }).first().click();
    await expect(page.locator('.cited-block')).toContainText('100만원');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    await page.screenshot({ path: 'test-results/desktop-local-chat.png' });
    expect(await readFile(path.join(root, '예산.md'), 'utf8')).toBe('# 예산\n예산은 100만원입니다.');
    await rm(path.join(root, '예산.md'));
    await expect(page.getByTestId('file-예산.md')).toHaveCount(0);
    await chat.getByRole('button', { name: '인용한 수정 이력 열기' }).first().click();
    await expect(page.locator('.context-document-preview')).toContainText('원본 파일 없음 · 저장된 스냅샷');
    await expect(page.locator('.cited-block')).toContainText('100만원');
    await expect(page.getByRole('button', { name: '원본 열기', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '미리보기 닫기' }).click();

    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    const restored = page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' });
    await restored.getByLabel('대화 기록', { exact: true }).selectOption({ label: '예산' });
    await expect(restored.locator('.chat-claim')).toContainText('100만원');
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('manual version linking and current selection change search without overwriting the original', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-links-ui-e2e-'));
  const root = path.join(base, '자료'); await mkdir(root);
  await writeFile(path.join(root, '원본.md'), '# 원본\n100만원'); await writeFile(path.join(root, '수정본.md'), '# 수정본\n200만원');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow(); await installSyntheticAI(app);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.getByTestId('file-수정본.md').locator('.paper-caption').dblclick(); await expect(page.locator('.preview-body')).toContainText('200만원');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    await page.getByTestId('file-원본.md').locator('.paper-caption').dblclick(); await expect(page.locator('.preview-body')).toContainText('100만원');
    await page.getByRole('button', { name: '수정 이력', exact: true }).click();
    await page.getByLabel('원본 문서', { exact: true }).selectOption({ label: '수정본.md' });
    await page.getByLabel('원본 수정 이력', { exact: true }).selectOption({ label: '수정 이력 1 · 수정본.md' });
    await page.getByRole('button', { name: '이 문서의 수정 이력으로 연결', exact: true }).click();
    await expect(page.getByRole('region', { name: '수정 이력 타임라인' })).toContainText('2개');
    await page.getByRole('button', { name: '수정 이력 2을 현재 수정 이력으로 지정', exact: true }).click();
    await expect(page.locator('.current-badge')).toContainText('현재 수정 이력');
    expect(await readFile(path.join(root, '원본.md'), 'utf8')).toBe('# 원본\n100만원');
    const results = await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; return api.searchContent(ws.id, '200만원'); });
    expect(results.length).toBe(2);
    await page.getByRole('button', { name: '수정 이력 비교', exact: true }).click();
    await page.getByRole('button', { name: '비교하기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 요약 요청', exact: true }).click();
    await expect(page.getByRole('article', { name: 'AI 변경 요약' })).toContainText('100만원에서 200만원');
    await page.getByRole('article', { name: 'AI 변경 요약' }).getByRole('link').first().click();
    await expect(page.locator('.diff-text')).toContainText(['원본', '100만원']);
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('native secure storage seals and removes a synthetic personal key without a network request', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-key-storage-e2e-'));
  const root = path.join(base, '자료'); await mkdir(root);
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 연결 설정', exact: true }).click();
    let settings = page.getByRole('dialog', { name: 'AI 연결 설정', exact: true });
    await settings.getByLabel('AI 연결 방식', { exact: true }).selectOption('personal');
    await expect(settings.getByLabel('ChatKHU API 키', { exact: true })).toBeEnabled();
    await settings.getByLabel('ChatKHU API 키', { exact: true }).fill('synthetic-local-test-key');
    await settings.getByRole('button', { name: '설정 저장', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('AI 연결 설정을 저장했습니다.');
    expect((await readFile(path.join(base, 'data', 'ai-connection.enc'))).includes('synthetic-local-test-key')).toBe(false);
    await expect(settings.getByLabel('ChatKHU API 키', { exact: true })).toHaveValue('');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: 'AI 연결 설정', exact: true }).click();
    settings = page.getByRole('dialog', { name: 'AI 연결 설정', exact: true });
    await expect(settings.getByLabel('AI 연결 방식', { exact: true })).toHaveValue('personal');
    await settings.getByRole('button', { name: '개인 키 삭제', exact: true }).click();
    await expect(settings.getByLabel('AI 연결 방식', { exact: true })).toHaveValue('managed');
    expect((await page.evaluate(() => window.contextDesktop.aiConnection())).has_personal_key).toBe(false);
    await settings.getByRole('button', { name: 'AI 설정 닫기' }).click();
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});


test('individual files disconnect without deletion, stay disconnected after restart and reconnect from the library', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-file-connection-e2e-'));
  const root = path.join(base, '내 문서'); await mkdir(root);
  const filename = path.join(root, '연결 해제.md'), original = '# 개별 파일\n개별연결테스트의 본문입니다.';
  await writeFile(filename, original);
  await writeFile(path.join(root, '사진.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64'));
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.getByTestId('file-연결 해제.md').locator('.paper-caption').dblclick();
    await expect(page.locator('.context-document-preview .text-block')).toContainText(['개별 파일', '개별연결테스트']);
    const before = await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; const entry = (await api.snapshot(ws.id)).entries.find(row => row.name === '연결 해제.md')!; return { entry, document: await api.getDocument(ws.id, entry.id) }; });
    await page.getByRole('button', { name: '파일 연결 해제', exact: true }).click();
    await expect(page.locator('.context-document-preview')).toHaveCount(0);
    await expect(page.getByTestId('file-연결 해제.md')).toHaveCount(0);
    await expect(page.getByTestId('file-사진.png')).toBeVisible();
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(page.getByTestId('file-연결 해제.md')).toHaveCount(0);
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    const chat = page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' });
    await chat.getByLabel('문서 질문', { exact: true }).fill('개별연결테스트');
    await chat.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(chat.getByRole('article', { name: 'AI 답변' })).toContainText('답변할 근거를 찾지 못했습니다.');
    await expect(chat.locator('.chat-source')).toHaveCount(0);
    await chat.getByRole('button', { name: 'AI 채팅 접기' }).click();
    await page.getByRole('button', { name: '문서 관리', exact: true }).click();
    await page.getByRole('button', { name: '사진.png 연결 해제', exact: true }).click();
    await page.getByRole('button', { name: '연결 해제한 파일 보기', exact: true }).click();
    await expect(page.getByRole('button', { name: '연결 해제.md 다시 연결' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '사진.png 다시 연결' })).toBeEnabled();
    await page.screenshot({ path: 'test-results/desktop-disconnected-files.png' });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByTestId('file-연결 해제.md')).toHaveCount(0);
    await expect(page.getByTestId('file-사진.png')).toHaveCount(0);
    await page.getByRole('button', { name: '문서 관리', exact: true }).click();
    await page.getByRole('button', { name: '연결 해제한 파일 보기', exact: true }).click();
    await page.getByRole('button', { name: '연결 해제.md 다시 연결', exact: true }).click();
    await expect(page.getByRole('button', { name: '연결 해제.md 다시 연결' })).toHaveCount(0);
    await page.getByRole('button', { name: '사진.png 다시 연결', exact: true }).click();
    await expect(page.getByRole('button', { name: '사진.png 다시 연결' })).toHaveCount(0);
    await page.getByRole('button', { name: '문서 관리 닫기', exact: true }).click();
    await expect(page.getByTestId('file-연결 해제.md')).toBeVisible();
    await expect(page.getByTestId('file-사진.png')).toBeVisible();
    const after = await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; const entry = (await api.snapshot(ws.id)).entries.find(row => row.name === '연결 해제.md')!; return { entry, document: await api.getDocument(ws.id, entry.id), sources: await api.searchContent(ws.id, '개별연결테스트') }; });
    expect(after.entry.id).toBe(before.entry.id);
    expect(after.entry.x).toBe(before.entry.x); expect(after.entry.y).toBe(before.entry.y);
    expect(after.document.versions.map(version => version.id)).toEqual(before.document.versions.map(version => version.id));
    expect(after.sources.length).toBeGreaterThan(0);
    expect(await readFile(filename, 'utf8')).toBe(original);
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});


test('reference zoom in a physical folder retains nearby files, folder geometry and canvas notes', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-reference-scene-e2e-'));
  const root = path.join(base, '캔버스 자료'); await mkdir(path.join(root, '리서치'), { recursive: true });
  await writeFile(path.join(root, '리서치', '예산.md'), '# 예산\n예산은 100만원입니다.');
  await writeFile(path.join(root, '리서치', '일정.md'), '# 일정\n다음 주에 검토합니다.');
  await writeFile(path.join(root, '바깥.md'), '# 원본');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await installSyntheticAI(app);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.evaluate(async () => { const api = window.contextDesktop, ws = (await api.list())[0]; await api.putCanvasItem(ws.id, '리서치', 'element', { id: crypto.randomUUID(), kind: 'text', text: '주변에 둔 메모', x: 0, y: 350, width: 240, height: 80, color: 'violet', font_size: 20 }, 0); });
    await page.getByRole('button', { name: '리서치 폴더 펼치기', exact: true }).click();
    await expect(page.getByTestId('file-예산.md')).toBeVisible();
    await expect(page.getByText('주변에 둔 메모', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    const box = page.getByTestId('folder-area-리서치').locator('> .canvas-decoration');
    const geometry = () => box.evaluate(node => { const area = node.closest<HTMLElement>('.react-flow__node')!; return { position: area.style.transform, width: area.style.width, height: area.style.height }; });
    const before = await geometry(), sibling = await page.getByTestId('file-일정.md').elementHandle();
    const chat = page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' });
    await chat.getByLabel('문서 질문', { exact: true }).fill('예산'); await chat.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(chat.locator('.chat-claim')).toContainText('100만원');
    await expect.poll(geometry).toEqual(before);
    expect(await sibling!.evaluate(node => node.isConnected)).toBeTruthy();
    await expect(page.getByText('주변에 둔 메모', { exact: true })).toBeVisible();
    await expect(page.locator('.breadcrumb-bar')).toHaveCount(0);
    await expect(chat.locator('.chat-source summary').first()).toBeHidden();
    await page.screenshot({ path: 'test-results/desktop-reference-folder.png' });
    expect(errors).toEqual([]);
    expect(await readFile(path.join(root, '리서치', '예산.md'), 'utf8')).toBe('# 예산\n예산은 100만원입니다.');
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});
