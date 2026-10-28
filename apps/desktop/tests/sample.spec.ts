import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('default sample opens without connecting or modifying personal workspaces and works in the packaged app',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'context-sample-ui-')),root=path.join(base,'개인 자료');
  await mkdir(root);await writeFile(path.join(root,'내 문서.txt'),'개인 원본은 그대로');
  const executablePath=process.env.CONTEXT_DESKTOP_EXECUTABLE;
  let app:ElectronApplication|undefined;
  try {
    app=await electron.launch({executablePath,args:executablePath?['--user-data-dir='+path.join(base,'data')]:['.'],cwd:process.cwd(),env:{...process.env,CONTEXT_DESKTOP_DATA_DIR:path.join(base,'data')}});
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await expect(page.getByRole('button',{name:'첫 폴더 연결하기'})).toBeVisible();
    await page.getByRole('button',{name:'하루랩 스타트업 샘플 열기',exact:true}).click();
    await expect(page.getByRole('region',{name:'샘플 프리뷰 안내'})).toContainText('40개');
    expect(await page.evaluate(()=>window.contextDesktop.list())).toEqual([]);
    const file=page.getByTestId('file-제품요구사항_v1.2.md');await expect(file).toBeVisible();
    await file.locator('.paper-caption').click();await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(file.getByRole('button',{name:/복사본/})).toBeVisible();
    await file.locator('.paper-caption').dblclick();await expect(page.getByRole('dialog')).toContainText('모아오더');
    await page.getByRole('button',{name:'미리보기 닫기'}).click();
    await expect(page.getByRole('button',{name:'AI 채팅',exact:true})).toBeEnabled();
    await page.screenshot({path:'test-results/sample-desktop.png'});
    for(const name of ['회사소개.pdf','주간업무보고_2026-10-23.hwpx','운영예산_2026Q4.xlsx','화면설계_모바일재고.png']) {
      await page.getByRole('button',{name:'문서 관리',exact:true}).click();
      await page.getByRole('textbox',{name:'관리할 파일 검색'}).fill(name);await page.getByRole('button',{name,exact:true}).click();
      const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
      if(name.endsWith('.png'))await expect.poll(()=>dialog.locator('img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
      else if(name.endsWith('.xlsx'))await expect(dialog.getByRole('table').first()).toBeVisible();
      else await expect(dialog.locator('.text-block').first()).toBeVisible();
      await page.getByRole('button',{name:'미리보기 닫기'}).click();
    }
    await page.getByRole('button',{name:'나의 워크스페이스',exact:true}).click();
    await expect(page.getByRole('button',{name:'첫 폴더 연결하기'})).toBeVisible();
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},root);
    await page.getByRole('button',{name:'첫 폴더 연결하기'}).click();await expect(page.getByTestId('file-내 문서.txt')).toBeVisible();
    const before=await page.evaluate(async()=>{const api=window.contextDesktop;return api.snapshot((await api.list())[0].id);});
    await page.getByRole('button',{name:'나의 워크스페이스',exact:true}).click();
    await page.getByRole('button',{name:'하루랩 스타트업 샘플 열기',exact:true}).click();
    await expect(page.locator('[data-sample-workspace="harulab"]')).toBeVisible();
    const after=await page.evaluate(async()=>{const api=window.contextDesktop;return api.snapshot((await api.list())[0].id);});
    expect(after.entries.map(entry=>[entry.id,entry.relative_path,entry.x,entry.y])).toEqual(before.entries.map(entry=>[entry.id,entry.relative_path,entry.x,entry.y]));
    expect(await readFile(path.join(root,'내 문서.txt'),'utf8')).toBe('개인 원본은 그대로');
    expect(errors).toEqual([]);
  } finally {if(app)await app.close();await rm(base,{recursive:true,force:true});}
});

test('sample document edits and canvas notes survive an app restart and can be reset', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-sample-edit-ui-'));
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
    await page.getByTestId('file-제품요구사항_v1.2.md').locator('.paper-caption').dblclick();
    await page.getByRole('button', { name: '본문 수정', exact: true }).click();
    const editor = page.getByRole('dialog', { name: /샘플 본문 편집/ });
    await editor.locator('.ce-paragraph[contenteditable="true"]').first().fill('앱 재시작 후 보존되는 샘플 수정');
    await page.screenshot({ path: 'test-results/sample-document-edit-desktop.png' });
    await editor.getByRole('button', { name: '샘플 저장', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('dialog')).toContainText('앱 재시작 후 보존되는 샘플 수정');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
    await page.getByRole('textbox', { name: '캔버스 텍스트 내용', exact: true }).fill('다시 열어도 남는 캔버스 메모');
    await page.getByRole('button', { name: '캔버스 수정 완료', exact: true }).click();
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
    await page.getByTestId('file-제품요구사항_v1.2.md').locator('.paper-caption').dblclick();
    await expect(page.getByRole('dialog')).toContainText('앱 재시작 후 보존되는 샘플 수정');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    expect(await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('context:sample-workspace:'))!;
      return JSON.parse(localStorage.getItem(key)!).items.some((item: { value: { text?: string } }) => item.value.text === '다시 열어도 남는 캔버스 메모');
    })).toBe(true);
    expect(await page.evaluate(() => window.contextDesktop.list())).toEqual([]);
    await page.getByRole('button', { name: '샘플 초기화', exact: true }).click();
    await page.getByRole('button', { name: '초기화 확인', exact: true }).click();
    await page.getByTestId('file-제품요구사항_v1.2.md').locator('.paper-caption').dblclick();
    await expect(page.getByRole('dialog')).not.toContainText('앱 재시작 후 보존되는 샘플 수정');
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('the focused sample folder moves with its files by dragging the heading, supports undo and persists after restart', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-sample-folder-drag-'));
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
    await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
    const folder = page.getByTestId('folder-area-02_제품기획'), file = page.getByTestId('file-제품요구사항_v1.2.md');
    const heading = page.getByLabel('02_제품기획 폴더 이동', { exact: true });
    await expect(heading).toBeInViewport(); await heading.hover();
    const before = (await folder.boundingBox())!, fileBefore = (await file.boundingBox())!, handle = (await heading.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 64, handle.y + handle.height / 2 + 42, { steps: 16 }); await page.mouse.up();
    const savedPosition = () => page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('context:sample-workspace:'))!;
      return JSON.parse(localStorage.getItem(key)!).data.entries.find((entry: { relative_path: string }) => entry.relative_path === '02_제품기획');
    });
    await expect.poll(async () => (await savedPosition()).area_positioned).toBe(true);
    await expect.poll(async () => (await folder.boundingBox())!.x - before.x).toBeGreaterThan(45);
    const moved = (await folder.boundingBox())!, fileAfter = (await file.boundingBox())!;
    expect(moved.y - before.y).toBeGreaterThan(25);
    expect(fileAfter.x - fileBefore.x).toBeCloseTo(moved.x - before.x, 0);
    expect(fileAfter.y - fileBefore.y).toBeCloseTo(moved.y - before.y, 0);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => Math.abs((await folder.boundingBox())!.x - before.x)).toBeLessThan(1);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await expect.poll(async () => Math.abs((await folder.boundingBox())!.x - moved.x)).toBeLessThan(1);
    const stored = await savedPosition();
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
    await expect(page.getByLabel('02_제품기획 폴더 이동', { exact: true })).toBeVisible();
    expect((await savedPosition()).x).toBe(stored.x); expect((await savedPosition()).y).toBe(stored.y);
    await expect.poll(async () => Math.abs((await page.getByTestId('folder-area-02_제품기획').boundingBox())!.x - moved.x)).toBeLessThan(2);
    await page.screenshot({ path: 'test-results/sample-folder-moved.png' });
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});

test('sample supports shared AI settings, grounded drafting and chat, DOCX export and restart persistence', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'context-sample-ai-ui-'));
  const executablePath = process.env.CONTEXT_DESKTOP_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? ['--user-data-dir=' + path.join(base, 'data')] : ['.'], cwd: process.cwd(), env: { ...process.env, CONTEXT_DESKTOP_DATA_DIR: path.join(base, 'data') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    // Replace only the paid AI boundary; sample retrieval, IPC, editor and storage are real.
    await app.evaluate(({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { AIConnections } = require(app.getAppPath() + '/electron/ai-connections.mjs');
      AIConnections.prototype.models = async () => [{ id: 'sample-test-model', name: '시연 테스트 모델' }];
      AIConnections.prototype.ensureReady = async () => {};
      AIConnections.prototype.generate = async (request: any) => {
        if (!request.sources.length || request.sources.some((source: any) => !source.id.startsWith('sample-'))) throw new Error('sample source boundary failed');
        const source = request.sources[0];
        return request.task === 'write' ? { content: { title: '모아오더 시연 소개서', blocks: [{ id: 'intro', type: 'paragraph', text: '하루랩 자료로 작성한 모아오더 소개입니다.', source_ids: [source.id] }] }, checks: [] }
          : { claims: [{ text: '모아오더 요구사항을 참고한 답변입니다.', source_ids: [source.id] }], insufficient: false };
      };
    });
    await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 연결 설정', exact: true }).first().click();
    const settings = page.getByRole('dialog', { name: 'AI 연결 설정', exact: true });
    await settings.getByRole('button', { name: '연결 확인 · 모델 불러오기' }).click();
    await settings.getByRole('combobox', { name: 'AI 모델', exact: true }).selectOption('sample-test-model');
    await settings.getByRole('button', { name: '설정 저장', exact: true }).click();
    await settings.getByRole('button', { name: 'AI 설정 닫기' }).click();
    expect((await page.evaluate(() => window.contextDesktop.aiConnection())).model).toBe('sample-test-model');
    await page.getByRole('button', { name: 'AI 문서 작성', exact: true }).click();
    await page.getByRole('textbox', { name: '어떤 문서를 만들까요?' }).fill('모아오더 제품 소개서를 작성해줘');
    await page.getByRole('button', { name: 'AI 초안 만들기' }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목' })).toHaveValue('모아오더 시연 소개서');
    await expect(page.locator('.writing-context')).toContainText('제품');
    const output = path.join(base, '샘플 소개서.docx');
    await app.evaluate(({ session }, filename) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(filename)); }, output);
    await page.getByRole('button', { name: 'DOCX', exact: true }).click();
    await expect.poll(async () => { try { return (await readFile(output)).subarray(0, 2).toString(); } catch { return ''; } }).toBe('PK');
    await page.getByRole('button', { name: '문서 작성 닫기' }).click();
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    const chat = page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' });
    await chat.getByRole('textbox', { name: '문서 질문', exact: true }).fill('모아오더 제품 요구사항이 뭐야?');
    await chat.getByRole('button', { name: '질문 보내기' }).click();
    await expect(chat).toContainText('모아오더 요구사항을 참고한 답변');
    await chat.getByRole('button', { name: /근거 보기/ }).first().click();
    await chat.getByRole('button', { name: '인용한 수정 이력 열기' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('모아오더');
    await page.getByRole('button', { name: '미리보기 닫기' }).click();
    expect(await page.evaluate(() => window.contextDesktop.list())).toEqual([]);
    expect(errors).toEqual([]);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: '하루랩 스타트업 샘플 열기', exact: true }).click();
    await page.getByRole('button', { name: 'AI 문서 작성', exact: true }).click();
    await page.getByRole('button', { name: '모아오더 시연 소개서', exact: true }).click();
    await expect(page.locator('.ce-paragraph')).toContainText('하루랩 자료로 작성한');
    await page.getByRole('button', { name: '문서 작성 닫기' }).click();
    await page.getByRole('button', { name: 'AI 채팅', exact: true }).click();
    await page.getByRole('combobox', { name: '대화 기록' }).selectOption({ label: '모아오더 제품 요구사항이 뭐야?' });
    await expect(page.getByRole('complementary', { name: 'AI 채팅과 문서 검색' })).toContainText('모아오더 요구사항을 참고한 답변');
    expect((await page.evaluate(() => window.contextDesktop.aiConnection())).model).toBe('sample-test-model');
    await page.screenshot({ path: 'test-results/sample-ai-desktop.png' });
  } finally { if (app) await app.close(); await rm(base, { recursive: true, force: true }); }
});
