import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('canvas conversions cache locally, save through native dialog and survive restart; documents and images copy beside their sources', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-derivatives-ui-'));
  const root = path.join(base, '자료'); await mkdir(root); await mkdir(path.join(root, '하위 자료'));
  await writeFile(path.join(root, '보고서.md'), '# 한글 보고서\n\n예산은 100만원입니다.');
  await writeFile(path.join(root, '하위 자료', '내부.txt'), '폴더 안의 원본 문서');
  const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, '사진.png'), picture);
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const card = page.getByTestId('file-보고서.md'); await expect(card).toBeVisible();
    // Conversion needs a parsed version; prepare it explicitly rather than racing background indexing.
    await page.evaluate(async () => { const api = window.contextDesktop, id = (await api.list())[0].id; const entry = (await api.snapshot(id)).entries.find(entry => entry.name === '보고서.md')!; await api.openDocument(id, entry.id); });
    await expect(card.locator('.paper-version')).toContainText('이력 1');
    // Wait for the initial camera transition before moving from the card to its floating controls.
    await page.locator('.react-flow__viewport').evaluate(async element => { let previous = '', stable = 0; while (stable < 12) { await new Promise(requestAnimationFrame); const value = getComputedStyle(element).transform; stable = value === previous ? stable + 1 : 0; previous = value; } });
    await card.hover();
    await expect(card.getByRole('button', { name: '보고서.md 형식 변환', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '보고서.md 복사본 생성하기', exact: true })).toHaveCount(0);
    await card.locator('.paper-caption').click(); await card.getByRole('button', { name: '보고서.md 형식 변환', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '보고서.md 형식 변환 패널' });
    for (const format of ['PDF', 'DOCX', 'HWPX', 'TXT', 'Markdown']) await expect(panel.getByRole('button', { name: `${format} 변환`, exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'DOCX 변환', exact: true }).click();
    await panel.getByRole('button', { name: '형식 변환 닫기' }).click();
    await card.getByRole('button', { name: '보고서.md 형식 변환', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'DOCX 저장', exact: true })).toBeEnabled();
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
    await panel.getByRole('button', { name: 'DOCX 저장', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'DOCX 저장', exact: true })).toBeEnabled();
    expect((await readdir(root)).sort()).toEqual(['보고서.md', '사진.png', '하위 자료'].sort());
    const output = path.join(base, '한글 변환.docx');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
    await panel.getByRole('button', { name: 'DOCX 저장', exact: true }).click();
    await expect.poll(async () => (await readFile(output).catch(() => Buffer.alloc(0))).subarray(0, 2).toString()).toBe('PK');
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'test-results/desktop-conversions.png' });
    await panel.getByRole('button', { name: '형식 변환 닫기' }).click();
    await card.locator('.paper-caption').click(); await card.getByRole('button', { name: '보고서.md 복사본 생성하기', exact: true }).click();
    const copied = page.getByTestId('file-보고서 copy.md'); await expect(copied).toBeVisible();
    expect(await readFile(path.join(root, '보고서 copy.md'), 'utf8')).toBe(await readFile(path.join(root, '보고서.md'), 'utf8'));
    const originalGeometry = await card.locator('.paper-sheet').boundingBox(), copyGeometry = await copied.locator('.paper-sheet').boundingBox();
    expect(copyGeometry!.x).toBeGreaterThan(originalGeometry!.x);
    await writeFile(path.join(root, '보고서 copy.md'), '# 복사본만 수정했습니다.');
    expect(await readFile(path.join(root, '보고서.md'), 'utf8')).toContain('예산은 100만원');
    const image = page.getByTestId('file-사진.png'); await image.locator('.paper-caption').click();
    await expect(image.getByRole('button', { name: '사진.png 형식 변환', exact: true })).toHaveCount(0);
    await image.getByRole('button', { name: '사진.png 복사본 생성하기', exact: true }).click();
    await expect(page.getByTestId('file-사진 copy.png')).toBeVisible();
    expect(await readFile(path.join(root, '사진 copy.png'))).toEqual(picture);
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    await page.getByRole('button', { name: '하위 자료 폴더 펼치기', exact: true }).click();
    const nested = page.getByTestId('file-내부.txt'); await expect(nested).toBeVisible(); await nested.locator('.paper-caption').click();
    await nested.getByRole('button', { name: '내부.txt 복사본 생성하기', exact: true }).click();
    await expect(page.getByTestId('file-내부 copy.txt')).toBeVisible();
    expect(await readFile(path.join(root, '하위 자료', '내부 copy.txt'), 'utf8')).toBe('폴더 안의 원본 문서');
    await page.mouse.move(500, 200);
    await page.locator('.statusbar').click();
    await expect(nested.locator('.document-copy-toggle')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/desktop-file-copies.png' });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: '작업 공간 전체 보기' }).click();
    const restored = page.getByTestId('file-보고서.md'); await restored.locator('.paper-caption').click();
    await restored.getByRole('button', { name: '보고서.md 형식 변환', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '보고서.md 형식 변환 패널' }).getByRole('button', { name: 'DOCX 저장', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '형식 변환 닫기' }).click();
    await restored.locator('.paper-caption').dblclick();
    await page.getByRole('button', { name: '내보내기', exact: true }).click();
    await expect(page.getByRole('region', { name: '문서 내보내기' }).getByRole('button', { name: 'DOCX 저장', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('copies remain inside nested canvas folders and connection tools share the bottom dock beside a wider chat', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-folder-tools-'));
  const root = path.join(base, '자료'), folder = path.join(root, '작업 자료');
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, '노트.txt'), '폴더 안의 원본');
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const groupId = await page.evaluate(async () => {
      const api = window.contextDesktop, workspace = (await api.list())[0].id, source = (await api.snapshot(workspace)).entries.find(entry => entry.name === '노트.txt')!;
      const groupId = crypto.randomUUID();
      await api.savePositions(workspace, [{ id: source.id, x: 650, y: 40 }]);
      await api.putCanvasItem(workspace, '작업 자료', 'element', { id: groupId, kind: 'rectangle', text: '자료 묶음', x: 0, y: 0, width: 1100, height: 850, color: 'blue', font_size: 24 }, 0);
      return groupId;
    });
    await page.getByRole('button', { name: '작업 자료 폴더 펼치기', exact: true }).click();
    await page.locator('.react-flow__viewport').evaluate(async element => { let previous = '', stable = 0; while (stable < 12) { await new Promise(requestAnimationFrame); const value = getComputedStyle(element).transform; stable = value === previous ? stable + 1 : 0; previous = value; } });
    const open = page.getByRole('button', { name: '자료 묶음 폴더 펼치기', exact: true });
    if (await open.isVisible()) await open.click();
    const card = page.getByTestId('file-노트.txt'); await expect(card).toBeVisible();
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const dock = page.getByRole('toolbar', { name: '캔버스 도구', exact: true });
    await expect(dock.getByRole('combobox', { name: '연결 유형' })).toBeVisible();
    await expect(page.locator('.local-relation-options')).toHaveCSS('position', 'static');
    await card.locator('.paper-caption').click();
    await card.getByRole('button', { name: '노트.txt 복사본 생성하기', exact: true }).click();
    const current = () => page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    await expect.poll(async () => { const copy = (await current()).entries.find(entry => entry.name === '노트 copy.txt'); return !!copy && copy.x !== null && copy.x + 200 <= 1100; }).toBe(true);
    const copy = (await current()).entries.find(entry => entry.name === '노트 copy.txt')!;
    const bounds = await page.evaluate(async groupId => { const api = window.contextDesktop; return (await api.canvasSnapshot((await api.list())[0].id, '작업 자료')).elements.find(item => item.id === groupId)!; }, groupId);
    expect(copy.parent_path).toBe('작업 자료'); expect(copy.x).toBeGreaterThanOrEqual(bounds.x); expect(copy.y).toBeGreaterThanOrEqual(bounds.y);
    expect(copy.x! + 200).toBeLessThanOrEqual(bounds.x + bounds.width); expect(copy.y! + 290).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(await readFile(path.join(folder, '노트 copy.txt'), 'utf8')).toBe('폴더 안의 원본');
    await page.evaluate(async copy => {
      const api = window.contextDesktop, workspace = (await api.list())[0].id, source = (await api.snapshot(workspace)).entries.find(entry => entry.name === '노트.txt')!;
      await api.putCanvasItem(workspace, '작업 자료', 'relation', { id: crypto.randomUUID(), source_document_id: copy.id, target_document_id: source.id, relation_type: 'GENERATED_FROM' }, 0);
    }, copy);
    const edge = page.locator('.react-flow__edge').first();
    await expect(edge.locator('.react-flow__edge-path')).toHaveAttribute('d', /[CQ]/);
    const point = await edge.locator('.react-flow__edge-path').evaluate(element => {
      const path = element as SVGPathElement;
      for (const fraction of [.05, .15, .25, .5, .75, .85, .95]) {
        const point = path.getPointAtLength(path.getTotalLength() * fraction);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
        if (document.elementFromPoint(screen.x, screen.y)?.closest('.react-flow__edge') === path.closest('.react-flow__edge')) return { x: screen.x, y: screen.y };
      }
      throw new Error('No visible segment of the connection');
    });
    await page.mouse.click(point.x, point.y);
    await expect(dock.getByRole('dialog', { name: '연결 옵션' })).toBeVisible();
    await expect(dock.getByRole('dialog', { name: '연결 옵션' })).toHaveCSS('position', 'static');
    await page.screenshot({ path: '/tmp/context-folder-tools-desktop.png' });
    await page.getByRole('button', { name: '연결 옵션 닫기' }).click();
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    await expect.poll(async () => (await page.locator('.chat-panel').boundingBox())?.width || 0).toBeGreaterThan(450);
    await page.screenshot({ path: '/tmp/context-folder-chat-desktop.png' });
  } finally { await app?.close(); await rm(base, { recursive: true, force: true }); }
});
