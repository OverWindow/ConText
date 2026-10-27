import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('physical folders reveal files on one canvas, preserve nested placement and restore after restart', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-spatial-e2e-'));
  const root = path.join(base, '프로젝트');
  await mkdir(path.join(root, '리서치', '이전 자료'), { recursive: true });
  await writeFile(path.join(root, '시작.md'), '# 시작');
  await writeFile(path.join(root, '리서치', '회의.txt'), '원본 회의 자료');
  await writeFile(path.join(root, '리서치', '이전 자료', '기록.md'), '# 과거 기록');
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    await page.evaluate(async () => { const api = window.contextDesktop, workspace = (await api.list())[0]; await api.putCanvasItem(workspace.id, '리서치', 'element', { id: crypto.randomUUID(), kind: 'text', text: '폴더 안 메모', x: -20, y: 350, width: 320, height: 140, color: 'violet', font_size: 24 }, 0); });
    const original = await page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    await expect(page.getByTestId('folder-area-리서치')).toBeVisible();
    await expect(page.getByTestId('file-리서치')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '리서치 폴더 펼치기', exact: true })).toBeVisible();
    await expect(page.getByTestId('file-회의.txt')).toHaveCount(0);
    await expect(page.getByText('폴더 안 메모', { exact: true })).toHaveCount(0);
    await page.locator('.desktop-canvas-surface').evaluate(node => { (node as HTMLElement).dataset.spatialInstance = 'same-canvas'; });
    await page.screenshot({ path: 'test-results/desktop-spatial-overview.png' });

    await page.getByRole('button', { name: '리서치 폴더 펼치기', exact: true }).click();
    await expect(page.getByTestId('file-회의.txt')).toBeVisible();
    await expect(page.getByTestId('folder-area-이전 자료')).toBeVisible();
    await expect(page.getByText('폴더 안 메모', { exact: true })).toBeVisible();
    await expect(page.locator('.desktop-canvas-surface')).toHaveAttribute('data-spatial-instance', 'same-canvas');
    await expect(page.locator('.breadcrumb-bar')).toHaveCount(0);
    await page.getByTestId('file-회의.txt').locator('.paper-caption').dblclick();
    await expect(page.locator('.preview-body')).toContainText('원본 회의 자료');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    await page.screenshot({ path: 'test-results/desktop-spatial-inside.png' });

    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const sheet = (await page.getByTestId('file-회의.txt').locator('.paper-sheet').boundingBox())!;
    await page.mouse.move(sheet.x + sheet.width / 2, sheet.y + 45); await page.mouse.down();
    await page.mouse.move(sheet.x + sheet.width / 2 + 45, sheet.y + 70, { steps: 10 }); await page.mouse.up();
    const current = () => page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    await expect.poll(async () => (await current()).entries.find(entry => entry.name === '회의.txt')?.x).not.toBe(original.entries.find(entry => entry.name === '회의.txt')!.x);
    const moved = (await current()).entries.find(entry => entry.name === '회의.txt')!;
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(entry => entry.name === '회의.txt')?.x).toBe(original.entries.find(entry => entry.name === '회의.txt')!.x);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(entry => entry.name === '회의.txt')?.x).toBe(moved.x);
    await page.getByRole('button', { name: '영역 선택', exact: true }).click();
    const selected = (await page.locator('.react-flow__node-file').filter({ has: page.getByTestId('file-회의.txt') }).boundingBox())!;
    await page.mouse.move(selected.x - 8, selected.y - 8); await page.mouse.down();
    await page.mouse.move(selected.x + selected.width + 8, selected.y + selected.height + 8, { steps: 10 }); await page.mouse.up();
    await expect(page.getByRole('region', { name: '선택한 파일 작업' })).toContainText('1개 파일 선택');
    await page.getByRole('button', { name: '영역 선택 종료' }).click();
    await page.getByRole('button', { name: '캔버스 수정 완료', exact: true }).click();
    await page.getByTestId('folder-area-이전 자료').locator('> .canvas-decoration').dblclick({ position: { x: 12, y: 12 } });
    await expect(page.getByTestId('file-기록.md')).toBeVisible();
    await expect(page.locator('.desktop-canvas-surface')).toHaveAttribute('data-spatial-instance', 'same-canvas');
    // Nested folders can start at different fitted scales. Wait for each zoom animation
    // and stop at the visible overview rather than assuming five rapid clicks aggregate.
    const overview = page.getByRole('button', { name: '리서치 폴더 펼치기', exact: true });
    for (let i = 0; i < 24 && !await overview.isVisible(); i++) {
      await page.getByRole('button', { name: '축소', exact: true }).click();
      await page.locator('.react-flow__viewport').evaluate(async element => { let previous = '', stable = 0; while (stable < 8) { await new Promise(requestAnimationFrame); const value = getComputedStyle(element).transform; stable = value === previous ? stable + 1 : 0; previous = value; } });
    }
    await expect(overview).toBeVisible();
    await expect(page.getByTestId('file-회의.txt')).toHaveCount(0);
    await expect(page.getByTestId('file-기록.md')).toHaveCount(0);
    await page.getByRole('button', { name: '리서치 폴더 펼치기', exact: true }).click();
    await expect(page.getByTestId('file-회의.txt')).toBeVisible();
    expect(await readFile(path.join(root, '리서치', '회의.txt'), 'utf8')).toBe('원본 회의 자료');
    expect(errors).toEqual([]);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByTestId('file-회의.txt')).toBeVisible();
    const restored = await current();
    expect(restored.entries.find(entry => entry.id === moved.id)?.x).toBe(moved.x);
    expect(restored.entries.find(entry => entry.id === moved.id)?.parent_path).toBe('리서치');
    expect(restored.spatial_focus).toBe('리서치');
    await expect(page.locator('.breadcrumb-bar')).toHaveCount(0);
    await page.getByRole('button', { name: '작업 공간 전체 보기', exact: true }).click();
    await expect(page.getByRole('button', { name: '리서치 폴더 펼치기', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const box = page.getByTestId('folder-area-리서치').locator('> .canvas-decoration');
    await box.hover({ position: { x: 20, y: 20 } });
    const region = (await box.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(region.x + 80, region.y + 50, { steps: 12 }); await page.mouse.up();
    await expect.poll(async () => (await current()).entries.find(entry => entry.name === '리서치')?.area_positioned).toBeTruthy();
    const movedRegion = (await current()).entries.find(entry => entry.name === '리서치')!;
    expect((await current()).entries.find(entry => entry.id === moved.id)?.x).toBe(moved.x);
    await app.close(); app = await launch(); page = await app.firstWindow();
    const again = await current();
    expect(again.entries.find(entry => entry.id === movedRegion.id)?.x).toBe(movedRegion.x);
    expect(again.entries.find(entry => entry.id === moved.id)?.x).toBe(moved.x);
    await page.getByTestId('folder-area-리서치').locator('> .canvas-decoration').dblclick({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId('file-회의.txt')).toBeVisible();
    await expect(page.getByText('폴더 안 메모', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '작업 공간 전체 보기', exact: true }).click();
    await page.getByRole('button', { name: '폴더 영역 모아 정렬', exact: true }).click();
    await expect.poll(async () => {
      const region = (await current()).entries.find(entry => entry.id === movedRegion.id)!;
      return region.x !== movedRegion.x || region.y !== movedRegion.y;
    }).toBe(true);
    expect((await current()).entries.find(entry => entry.id === moved.id)?.x).toBe(moved.x);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === movedRegion.id)?.x).toBe(movedRegion.x);
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('nine automatic folder regions open as nearby rows instead of a distant horizontal strip', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-compact-e2e-'));
  const root = path.join(base, '모아 보는 자료');
  for (let i = 1; i <= 9; i++) {
    const folder = path.join(root, `자료 ${String(i).padStart(2, '0')}`);
    await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, '노트.md'), '# 폴더의 내용');
  }
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    for (let i = 1; i <= 9; i++) await expect(page.getByRole('button', { name: `자료 ${String(i).padStart(2, '0')} 폴더 펼치기`, exact: true })).toBeInViewport();
    const geometry = await page.locator('.local-folder-area').evaluateAll(nodes => {
      const boxes = nodes.map(node => node.getBoundingClientRect());
      const width = Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left));
      const height = Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top));
      return { ratio: width / height, rows: new Set(boxes.map(b => Math.round(b.top / 10))).size };
    });
    expect(geometry.ratio).toBeLessThan(1.7); expect(geometry.rows).toBeGreaterThan(1);
    await page.screenshot({ path: 'test-results/desktop-compact-folders.png' });
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('long folder names stay complete and mixed file cards match their folder representative', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-readable-e2e-'));
  const root = path.join(base, '함께 보는 자료'), name = '2026년 공동 연구 프로젝트의 회의록과 참고 문헌 및 검토 자료 모음_긴이름도끝까지표시';
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, '기획.md'), '# 프로젝트 기획');
  await writeFile(path.join(root, '일정.md'), '# 다음 일정');
  await writeFile(path.join(root, name, '내부 기록.md'), '# 폴더 안 기록');
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const folder = page.getByRole('button', { name: `${name} 폴더 펼치기`, exact: true });
    await expect(folder).toBeInViewport();
    await expect(folder.locator('strong')).toHaveText(name);
    expect(await folder.locator('strong').evaluate(node => ({ fits: node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1, overflow: getComputedStyle(node).textOverflow, lines: node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight) }))).toMatchObject({ fits: true, overflow: 'clip' });
    const card = page.getByTestId('file-기획.md').locator('.paper-sheet');
    const folderBox = (await folder.boundingBox())!, fileBox = (await card.boundingBox())!;
    expect(Math.abs(folderBox.width - fileBox.width)).toBeLessThan(2);
    expect(Math.abs(folderBox.height - fileBox.height)).toBeLessThan(2);
    expect(fileBox.x + fileBox.width <= folderBox.x || folderBox.x + folderBox.width <= fileBox.x || fileBox.y + fileBox.height <= folderBox.y || folderBox.y + folderBox.height <= fileBox.y).toBe(true);
    await page.mouse.move(20, 20);
    await page.screenshot({ path: 'test-results/desktop-readable-mixed.png' });
    const before = await page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    const file = before.entries.find(entry => entry.name === '기획.md')!;
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    await expect(page.getByRole('button', { name: '캔버스 수정 완료', exact: true })).toBeVisible();
    await card.hover(); const box = (await card.boundingBox())!;
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 12, { steps: 10 }); await page.mouse.up();
    const savedX = () => page.evaluate(async id => { const api = window.contextDesktop; return (await api.snapshot((await api.list())[0].id)).entries.find(entry => entry.id === id)!.x; }, file.id);
    await expect.poll(savedX).not.toBe(file.x);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(savedX).toBe(file.x);
    await page.getByRole('button', { name: '캔버스 수정 완료', exact: true }).click();
    await folder.click();
    await expect(page.getByTestId('file-내부 기록.md')).toBeVisible();
    const label = page.locator('.local-folder-heading').filter({ hasText: name });
    await expect(label).toContainText(name);
    expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await readFile(path.join(root, name, '내부 기록.md'), 'utf8')).toBe('# 폴더 안 기록');
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('editing preserves folder box geometry, drags the whole box and drops files into real folders with undo', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-drop-e2e-'));
  const root = path.join(base, '폴더로 옮기는 자료');
  await mkdir(path.join(root, '보관'), { recursive: true });
  await mkdir(path.join(root, '보관', '더 안쪽'));
  await writeFile(path.join(root, '옮길.md'), '# 이동할 원문');
  await writeFile(path.join(root, '충돌.md'), '# 원본 충돌 자료');
  await writeFile(path.join(root, '보관', '충돌.md'), '# 대상에 있던 원문');
  await writeFile(path.join(root, '보관', '더 안쪽', '숨길.md'), '# 내부 원문');
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
    const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    app = await launch(); let page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const folder = page.getByTestId('folder-area-보관');
    const representative = folder.getByRole('button', { name: '보관 폴더 펼치기' });
    await representative.hover();
    // Arrange the canvas above the floating tools before comparing either mode.
    const canvas = (await page.locator('.desktop-canvas-surface').boundingBox())!;
    await page.mouse.move(canvas.x + canvas.width - 20, canvas.y + canvas.height / 2); await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width - 20, canvas.y + canvas.height / 2 - 150, { steps: 12 }); await page.mouse.up();
    await representative.hover();
    const originalBox = (await folder.boundingBox())!;
    const viewport = page.locator('.react-flow__viewport');
    const originalView = (await viewport.getAttribute('style'))!;
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    await expect(page.getByRole('button', { name: '캔버스 수정 완료', exact: true })).toBeVisible();
    const editingBox = (await folder.boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(editingBox[key]).toBeCloseTo(originalBox[key], 1);
    await expect(viewport).toHaveAttribute('style', originalView);
    await expect(folder.getByRole('button', { name: '보관 폴더 펼치기' })).toBeVisible();
    await expect(page.getByTestId('file-숨길.md')).toHaveCount(0);
    await expect(page.getByTestId('folder-area-더 안쪽')).toHaveCount(0);
    await expect(page.locator('.local-folder-enter')).toHaveCount(0);
    await expect(page.locator('.local-folder-grip')).toHaveCount(0);
    const current = () => page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    const original = await current(), source = original.entries.find(entry => entry.name === '옮길.md')!, area = original.entries.find(entry => entry.relative_path === '보관')!;
    await representative.hover();
    const card = (await representative.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2 + 24, card.y + card.height / 2 + 12, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === area.id)?.area_positioned).toBeTruthy();
    const movedBox = (await folder.boundingBox())!;
    // React Flow starts movement after the pointer clears its drag threshold.
    expect(movedBox.x - originalBox.x).toBeGreaterThan(18);
    expect(movedBox.x - originalBox.x).toBeLessThan(26);
    expect(movedBox.y - originalBox.y).toBeGreaterThan(6);
    expect(movedBox.y - originalBox.y).toBeLessThan(14);
    expect(movedBox.width).toBeCloseTo(originalBox.width, 1);
    expect(movedBox.height).toBeCloseTo(originalBox.height, 1);
    await expect(page.getByTestId('file-숨길.md')).toHaveCount(0);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await page.getByRole('button', { name: '캔버스 수정 완료', exact: true }).click();
    const restoredBox = (await folder.boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(restoredBox[key]).toBeCloseTo(originalBox[key], 1);
    await expect(viewport).toHaveAttribute('style', originalView);
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const drop = async (name: string) => {
      const paper = page.getByTestId(`file-${name}`).locator('.paper-sheet');
      await paper.hover(); const target = (await folder.boundingBox())!;
      await page.mouse.down(); await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
      await expect(folder).toHaveClass(/is-file-drop-target/);
      await page.mouse.up();
    };
    await drop('옮길.md');
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === source.id)?.relative_path).toBe('보관/옮길.md');
    await expect(page.getByTestId('file-옮길.md')).toHaveCount(0);
    await expect(page.getByTestId('file-숨길.md')).toHaveCount(0);
    expect(await readFile(path.join(root, '보관', '옮길.md'), 'utf8')).toBe('# 이동할 원문');
    await expect.poll(async () => { try { await readFile(path.join(root, '옮길.md')); return true; } catch { return false; } }).toBe(false);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === source.id)?.relative_path).toBe('옮길.md');
    await expect(page.getByTestId('file-옮길.md')).toBeVisible();
    expect((await current()).entries.find(entry => entry.id === source.id)?.x).toBe(source.x);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === source.id)?.relative_path).toBe('보관/옮길.md');
    await page.mouse.move(20, 20); await page.screenshot({ path: 'test-results/desktop-collapsed-edit.png' });
    await drop('충돌.md');
    await expect(page.getByText('대상 폴더에 같은 이름의 파일이 있습니다. 기존 파일은 보존했습니다.', { exact: true })).toBeVisible();
    expect(await readFile(path.join(root, '충돌.md'), 'utf8')).toBe('# 원본 충돌 자료');
    expect(await readFile(path.join(root, '보관', '충돌.md'), 'utf8')).toBe('# 대상에 있던 원문');
    await expect(page.getByTestId('file-숨길.md')).toHaveCount(0);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '캔버스 수정 완료', exact: true })).toBeVisible();
    await expect(page.getByTestId('file-숨길.md')).toHaveCount(0);
    expect((await current()).entries.find(entry => entry.id === source.id)?.relative_path).toBe('보관/옮길.md');
    expect(await readFile(path.join(root, '보관', '옮길.md'), 'utf8')).toBe('# 이동할 원문');
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('eight-item folder frame keeps zoom-revealed contents editable and uses one centred bottom dock', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-capped-spatial-'));
  const root = path.join(base, '상한 확인');
  await mkdir(path.join(root, '많은 자료'), { recursive: true });
  for (let i = 0; i < 32; i++) await writeFile(path.join(root, '많은 자료', `자료_${String(i).padStart(2, '0')}.md`), `# 자료 ${i}`);
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
    app = await electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const file = page.getByTestId('file-자료_00.md'), folder = page.getByTestId('folder-area-많은 자료');
    await expect(folder).toBeVisible();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '확대', exact: true }).click();
    await expect(file).toBeVisible();
    const view = await page.locator('.react-flow__viewport').getAttribute('style');
    const before = (await folder.boundingBox())!;
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    await expect(file).toBeVisible();
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', view!);
    const after = (await folder.boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(after[key]).toBeCloseTo(before[key], 1);
    await expect(page.locator('.breadcrumb-bar,.canvas-tip,.local-navigation-tools,.paper-glyph')).toHaveCount(0);
    const tools = (await page.getByRole('toolbar', { name: '텍스트와 배경 도형' }).boundingBox())!;
    const controls = (await page.locator('.react-flow__controls').boundingBox())!;
    expect(Math.abs(tools.y - controls.y)).toBeLessThan(4); expect(tools.x).toBeGreaterThan(controls.x);
    const dock = (await page.getByRole('toolbar', { name: '캔버스 도구', exact: true }).boundingBox())!;
    const canvas = (await page.locator('.desktop-canvas-surface').boundingBox())!;
    expect(Math.abs(dock.x + dock.width / 2 - canvas.x - canvas.width / 2)).toBeLessThan(2);
    const current = () => page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    const original = (await current()).entries.find(entry => entry.name === '자료_00.md')!;
    const paper = (await file.locator('.paper-sheet').boundingBox())!;
    await page.mouse.move(paper.x + paper.width / 2, paper.y + paper.height / 2); await page.mouse.down();
    await page.mouse.move(paper.x + paper.width / 2 + 12, paper.y + paper.height / 2 + 8, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === original.id)?.x).not.toBe(original.x);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(entry => entry.id === original.id)?.x).toBe(original.x);
    await page.screenshot({ path: 'test-results/desktop-capped-folders.png' });
    expect(errors).toEqual([]);
    expect(await readFile(path.join(root, '많은 자료', original.name), 'utf8')).toBe('# 자료 0');
  } finally { await app?.close(); await rm(base, { recursive: true, force: true }); }
});

test('trackpad pans, nested edit clicks reveal locally, and text and folder insertion preserve saved rows', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-motion-e2e-'));
  const root = path.join(base, '자료');
  await mkdir(path.join(root, '바깥', '안쪽', '깊은 폴더'), { recursive: true });
  await writeFile(path.join(root, '시작.md'), '# 시작');
  for (let i = 0; i < 7; i++) {
    await mkdir(path.join(root, '바깥', `다른 폴더 ${i}`));
    await mkdir(path.join(root, '바깥', '안쪽', `이전 폴더 ${i}`));
  }
  for (let i = 0; i < 12; i++) await writeFile(path.join(root, '바깥', '안쪽', '깊은 폴더', `${i}.md`), '# 깊은 기록');
  let app: ElectronApplication | undefined;
  try {
    const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
    const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await page.getByRole('button', { name: '첫 폴더 연결하기' }).click();
    const current = () => page.evaluate(async () => { const api = window.contextDesktop; return api.snapshot((await api.list())[0].id); });
    const view = () => page.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
    const before = await view();
    await page.mouse.move(1150, 650); await page.mouse.wheel(80, 50);
    await expect.poll(async () => (await view()).x).toBeLessThan(before.x - 30);
    expect((await view()).zoom).toBeCloseTo(before.zoom, 5);
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const outer = page.getByRole('button', { name: '바깥 폴더 펼치기', exact: true });
    await expect(outer.locator('svg,.folder-count')).toHaveCount(0);
    await outer.click();
    const inner = page.getByRole('button', { name: '안쪽 폴더 펼치기', exact: true });
    await expect(inner).toBeVisible(); await inner.click();
    const deep = page.getByRole('button', { name: '깊은 폴더 폴더 펼치기', exact: true });
    await expect(deep).toBeVisible(); await deep.click();
    await expect(page.getByTestId('file-0.md')).toBeVisible();
    await expect(page.getByRole('button', { name: '캔버스 수정 완료', exact: true })).toBeVisible();
    await expect.poll(async () => (await view()).zoom).toBeGreaterThan(2);
    await expect.poll(async () => (await current()).views.find(v => v.directory === ':spatial:readable')?.zoom || 0).toBeGreaterThan(2);
    const deepZoom = (await current()).views.find(v => v.directory === ':spatial:readable')!.zoom;
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByTestId('file-0.md')).toBeVisible();
    await expect.poll(async () => (await view()).zoom).toBeCloseTo(deepZoom, 4);
    await expect(page.getByRole('button', { name: '확대', exact: true })).toBeEnabled();
    await page.screenshot({ path: 'test-results/desktop-nested-motion.png' });
    await page.getByRole('button', { name: '작업 공간 전체 보기', exact: true }).click();
    await expect.poll(async () => (await view()).zoom).toBeLessThanOrEqual(.32001);
    const original = await current();
    await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
    await page.getByRole('textbox', { name: '캔버스 텍스트 내용' }).fill('위에 겹치는 메모');
    await page.getByRole('button', { name: '요소 선택 해제', exact: true }).click();
    const afterText = await current();
    for (const entry of original.entries) expect(afterText.entries.find(e => e.id === entry.id)?.x).toBe(entry.x);
    await page.getByRole('button', { name: '사각형 폴더 추가', exact: true }).click();
    await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
    const after = await current();
    for (const entry of original.entries) {
      const placed = after.entries.find(e => e.id === entry.id)!;
      if (entry.kind === 'file') { expect(placed.y).toBe(entry.y); expect(Math.abs((placed.x || 0) - (entry.x || 0))).toBeLessThanOrEqual(160); }
    }
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '새 텍스트 파일 만들기', exact: true }).click();
    await page.getByRole('textbox', { name: '이름', exact: true }).fill('추가한 파일.md');
    await page.getByRole('button', { name: '파일 만들기', exact: true }).click();
    await expect(page.getByRole('button', { name: '텍스트 편집 닫기', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '텍스트 편집 닫기', exact: true }).click();
    const created = (await current()).entries.find(e => e.name === '추가한 파일.md')!;
    expect(created).toBeTruthy();
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(page.getByRole('button', { name: '다시 실행', exact: true })).toBeEnabled();
    expect((await current()).entries.some(e => e.id === created.id)).toBe(true);
    expect(await readFile(path.join(root, '추가한 파일.md'), 'utf8')).toBe('');
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect.poll(async () => (await current()).entries.find(e => e.id === created.id)?.x).toBe(created.x);
    const clear = page.getByRole('button', { name: '요소 선택 해제', exact: true });
    if (await clear.isVisible()) await clear.click();
    await page.screenshot({ path: 'test-results/desktop-canvas-motion.png' });
    expect(errors).toEqual([]);
    expect(await readFile(path.join(root, '시작.md'), 'utf8')).toBe('# 시작');
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});
