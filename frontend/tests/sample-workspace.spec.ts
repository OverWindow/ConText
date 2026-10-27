import { expect, test } from '@playwright/test';
test('guest sample opens offline data with the shared canvas, links and read-only previews',async({page},info)=>{
  const errors:string[]=[],apiRequests:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:3102/**',route=>{apiRequests.push(route.request().url());return route.abort();});
  await page.goto('/preview');
  await expect(page.getByRole('heading').filter({hasText:'하루랩 스타트업 샘플'})).toBeVisible();
  await expect(page.getByRole('region',{name:'샘플 프리뷰 안내'})).toContainText('40개');
  const file=page.getByTestId('file-제품요구사항_v1.2.md');await expect(file).toBeVisible();
  await expect.poll(()=>page.locator('.react-flow__edge:visible').count()).toBeGreaterThanOrEqual(3);
  await file.locator('.paper-caption').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(file.getByRole('button',{name:/복사본|변환/})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'캔버스 수정',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'AI 채팅',exact:true})).toBeDisabled();
  await file.locator('.paper-caption').dblclick();
  await expect(page.getByRole('dialog')).toContainText('모아오더');
  await page.getByRole('button',{name:'미리보기 닫기'}).click();
  await page.screenshot({path:`test-results/sample-web-${info.project.name}.png`});
  await page.getByRole('textbox',{name:'파일 이름 검색'}).fill('회사소개');
  await page.getByTestId('file-회사소개.pdf').locator('.paper-caption').dblclick();
  await expect(page.getByRole('dialog')).toContainText('하루랩');
  expect(apiRequests).toEqual([]);expect(errors).toEqual([]);
});
test('sample library reads images, HWPX, spreadsheet tables and nested text without a backend',async({page})=>{
  await page.goto('/preview');
  for(const name of ['화면설계_모바일재고.png','주간업무보고_2026-10-23.hwpx','운영예산_2026Q4.xlsx','한글_日本語_English.txt','빈문서.txt']) {
    await page.getByRole('button',{name:'문서 관리',exact:true}).click();
    await page.getByRole('textbox',{name:'관리할 파일 검색'}).fill(name);
    await page.getByRole('button',{name,exact:true}).click();
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    if(name.endsWith('.png'))await expect.poll(()=>dialog.locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
    else if(name.endsWith('.xlsx'))await expect(dialog.getByRole('table').first()).toBeVisible();
    else if(name==='빈문서.txt')await expect(dialog).toContainText('내용이 없는 빈 샘플');
    else await expect(dialog.locator('.text-block').first()).toBeVisible();
    await page.getByRole('button',{name:'미리보기 닫기'}).click();
  }
});
test('landing and login offer the public sample before account creation',async({page})=>{
  await page.goto('/');await page.getByRole('link',{name:'로그인 없이 하루랩 샘플 둘러보기'}).click();
  await page.waitForURL('**/preview', { timeout: 15000 });
  await expect(page.locator('[data-sample-workspace="harulab"]')).toBeVisible();
  await page.getByRole('button',{name:'나의 워크스페이스',exact:true}).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('link',{name:/로그인 없이 샘플 먼저 둘러보기/}).click();
  await expect(page).toHaveURL(/\/preview/);
});
