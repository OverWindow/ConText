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
    await expect(file.getByRole('button',{name:/복사본|변환/})).toHaveCount(0);
    await file.locator('.paper-caption').dblclick();await expect(page.getByRole('dialog')).toContainText('모아오더');
    await page.getByRole('button',{name:'미리보기 닫기'}).click();
    await expect(page.getByRole('button',{name:'AI 채팅',exact:true})).toBeDisabled();
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
