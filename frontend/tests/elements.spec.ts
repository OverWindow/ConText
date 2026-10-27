import { test, expect, type Page } from "@playwright/test";
import { projectFolders } from "../shared/canvas/folder-projection";
import { planFolderMove, folderDropExpansion, applyFolderBounds, folderMembership } from "../features/canvas/canvas-folders";
import type { ElementNode } from "../features/canvas/canvas-elements";
import type { DocumentNode } from "../features/canvas/document-card";
const workspace = "00000000-0000-0000-0000-000000000002";
type Element = { id: string; kind: string; text: string; x: number; y: number; width: number; height: number; color: string; font_size: number };
async function prepare(page: Page, role = "OWNER", fail = false, initialElements: Element[] = [], fileCount?: number) {
  const user = { id: "00000000-0000-0000-0000-000000000001", email: "test@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} };
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: "authenticated" })}.test-signature`;
  await page.context().addCookies([{ name: "sb-127-auth-token", value: "base64-" + encode({ access_token: token, refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user }), domain: "localhost", path: "/" }]);
  let elements: Element[] = initialElements.length ? initialElements : role === "VIEWER" ? [{ id: "read-text", kind: "text", text: "읽기 전용 메모", x: 0, y: 0, width: 300, height: 100, font_size: 24, color: "violet" }] : [];
  let patchCalls = 0;
  let mutations = 0;
  const docs = [{ id: "doc-0", workspace_id: workspace, title: "계획서", current_version_id: "v1", versions: [{ id: "v1", document_id: "doc-0", version_number: 1, original_filename: "계획서.md", size: 50, sha256: "a".repeat(64), status: "READY" }] }];
  if (initialElements.length) docs.push({ ...docs[0], id: "doc-1", title: "외부 문서", current_version_id: "v2", versions: [{ ...docs[0].versions[0], id: "v2", document_id: "doc-1", original_filename: "외부 문서.md" }] });
  if (fileCount !== undefined) {
    const first = docs[0]; docs.splice(0, docs.length);
    for (let i = 0; i < fileCount; i++) docs.push({ ...first, id: `doc-${i}`, title: `파일 ${i}`, current_version_id: `v-${i}`, versions: [{ ...first.versions[0], id: `v-${i}`, document_id: `doc-${i}`, original_filename: `파일_${i}.md` }] });
  }
  let positions = [{ document_id: "doc-0", x: 500, y: -150 }, { document_id: "doc-1", x: 1350, y: -150 }];
  if (fileCount !== undefined) positions = docs.map((doc, i) => ({ document_id: doc.id, x: 80 + i % 8 * 220, y: 100 + Math.floor(i / 8) * 335 }));
  await page.route("http://localhost:3102/api/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; let data: unknown;
    expect(req.headers().authorization).toBe(`Bearer ${token}`);
    if (req.method() !== "GET") mutations++;
    if (path.endsWith("/canvas/elements")) { const body = req.postDataJSON(); elements.push(body); data = body; }
    else if (path.includes("/canvas/elements/")) {
      const id = path.split("/").at(-1)!;
      if (req.method() === "DELETE") { elements = elements.filter(e => e.id !== id); await route.fulfill({ status: 204 }); return; }
      patchCalls++;
      if (fail && patchCalls === 1) { await route.fulfill({ status: 503, json: { detail: "잠시 저장할 수 없습니다" } }); return; }
      elements = elements.map(e => e.id === id ? { ...e, ...req.postDataJSON() } : e); data = elements.find(e => e.id === id);
    } else if (path.endsWith("/canvas/positions")) {
      const changes = req.postDataJSON().positions as typeof positions;
      positions = [...positions.filter(p => !changes.some(c => c.document_id === p.document_id)), ...changes]; data = changes;
    } else if (path.endsWith("/canvas")) data = { documents: docs, positions, relations: [], elements };
    else if (path.endsWith("/members")) data = [];
    else if (path.endsWith("/documents/doc-0")) data = docs[0];
    else if (path.endsWith("/processing")) data = { state: "READY", summary: { block_count: 1, character_count: 50, page_count: 1 } };
    else if (path.endsWith("/content")) data = { blocks: [], warnings: [], total: 0, has_more: false };
    else data = { id: workspace, name: "아이디어 보드", role };
    await route.fulfill({ json: data });
  });
  await page.goto(`/workspaces/${workspace}`);
  await expect(page.locator(initialElements.length ? '.react-flow__node-decoration' : '.react-flow__node[data-id="doc-0"]')).not.toHaveCount(0, { timeout: 12000 });
  await expect(page.getByLabel("문서 캔버스", { exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("toolbar", { name: "텍스트와 배경 도형" })).toHaveCount(0);
  if (role !== "VIEWER") await page.getByRole("button", { name: "캔버스 수정", exact: true }).click();
  return { elements: () => elements, positions: () => positions, patchCalls: () => patchCalls, mutations: () => mutations };
}

test("text edits, font, resize handle and location persist after reload", async ({ page }, info) => {
  const state = await prepare(page);
  await page.getByRole("button", { name: "텍스트 추가", exact: true }).click();
  const text = page.getByRole("textbox", { name: "캔버스 텍스트 내용" });
  await text.fill("다음 분기 로드맵\n팀과 함께 정리하는 생각");
  await page.getByLabel("글자 크기", { exact: true }).selectOption("32");
  await page.getByRole("button", { name: "파랑 색상" }).click();
  const node = page.locator('.react-flow__node-decoration');
  const handle = node.locator(info.project.name === 'mobile' ? '.react-flow__resize-control.handle.bottom.left' : '.react-flow__resize-control.handle.bottom.right');
  const box = await handle.boundingBox();
  if (!box) throw new Error("Missing resize handle");
  await page.screenshot({ path: `/tmp/canvas-before-resize-${info.project.name}.png` });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + (info.project.name === "mobile" ? -30 : 70), box.y + 70, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => state.elements()[0]?.width).toBeGreaterThan(330);
  await expect.poll(() => state.elements()[0]?.text).toContain("다음 분기");
  const grip = await node.locator('.decoration-grip').boundingBox();
  if (!grip) throw new Error("Missing drag grip");
  const oldX = state.elements()[0].x;
  await page.mouse.move(grip.x + 15, grip.y + 10); await page.mouse.down(); await page.mouse.move(grip.x - 50, grip.y + 55, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => state.elements()[0].x).not.toBe(oldX);
  await expect(page.getByText("텍스트·도형 저장됨", { exact: true })).toBeVisible();
  const saved = { ...state.elements()[0] };
  await page.getByRole("button", { name: "요소 선택 해제" }).click();
  await page.screenshot({ path: `/tmp/canvas-text-${info.project.name}.png` });
  await page.reload();
  await expect(page.getByText("다음 분기 로드맵", { exact: false })).toBeVisible();
  expect(state.elements()[0]).toEqual(saved);
  await expect(page.locator('.decoration-text-content')).toHaveCSS("font-size", "32px");
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

const folderFixture: Element = { id: "folder", kind: "rectangle", text: "", x: 400, y: -250, width: 800, height: 550, color: "violet", font_size: 24 };

test('folder geometry keeps remaining files enclosed and rejects distant drops', () => {
  const folder = { id: 'element:folder', position: { x: 0, y: 0 }, width: 900, height: 700,
    data: { element: { ...folderFixture, id: 'folder', kind: 'rectangle', x: 0, y: 0, width: 900, height: 700 } } } as ElementNode;
  const documents = [{ id: 'stay', position: { x: 50, y: 50 }, measured: { width: 200, height: 290 } },
    { id: 'leave', position: { x: 650, y: 350 }, measured: { width: 200, height: 290 } }] as DocumentNode[];
  const plan = planFolderMove([folder], documents, [{ id: 'leave', origin: documents[1].position, position: { x: 1200, y: 350 } }]);
  expect(plan.changes).toHaveLength(1);
  expect(plan.changes[0].after.width).toBeLessThan(900);
  expect(plan.changes[0].after.height).toBeLessThan(700);
  const updated = applyFolderBounds(folder, plan.changes[0].after);
  expect(folderMembership([updated], documents).members.get('element:folder')?.map(node => node.id)).toEqual(['stay']);
  expect(documents[0].position).toEqual({ x: 50, y: 50 });
  expect(folderDropExpansion([folder], { ...documents[1], position: { x: 1200, y: 350 } })).toBeNull();
  const near = { ...documents[1], position: { x: 820, y: 350 } };
  expect(folderDropExpansion([folder], near)?.after.width).toBeGreaterThan(900);
  const neighbour = { ...folder, id: 'element:neighbour', position: { x: 900, y: 0 }, width: 800, data: { element: { ...folder.data.element, id: 'neighbour' } } };
  expect(folderDropExpansion([folder, neighbour], near)?.id).toBe('neighbour');
  expect(folderDropExpansion([{ ...folder, width: 2000 }], { ...near, position: { x: 1900, y: 350 } })?.tooLarge).toBe(true);
});

for (const fromFolder of [false, true]) test(`dropping ${fromFolder ? 'another folder file' : 'an outside file'} grows the target and undo restores both`, async ({ page }, info) => {
  // Keep both folders visible at detail zoom; the capped-folder case covers portrait.
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 720, height: 844 });
  const initial = [{ ...folderFixture, text: '대상 폴더' }];
  if (fromFolder) initial.push({ ...folderFixture, id: 'source', text: '원래 폴더', x: 1280, width: 400 });
  const state = await prepare(page, 'OWNER', false, initial);
  for (let i = 0; i < 8 && !await page.locator('.react-flow__node[data-id="doc-1"]').count(); i++) await page.getByRole('button', { name: '확대', exact: true }).click();
  const target = page.locator('.react-flow__node[data-id="element:folder"]');
  const targetLabel = page.locator('.react-flow__node-toolbar[data-id="element:folder"]');
  const file = page.locator('.react-flow__node[data-id="doc-1"]');
  const expandTarget = targetLabel.getByRole('button', { name: '대상 폴더 폴더 펼치기' });
  if (await expandTarget.count()) await expandTarget.click();
  await expect(targetLabel.getByLabel('포함된 파일 1개')).toBeVisible();
  const origin = { ...state.positions().find(p => p.document_id === 'doc-1')! };
  // Include a forgiving drop with the centre 20px outside the lower-right edge.
  const region = (await target.boundingBox())!;
  const card = (await file.boundingBox())!;
  const scale = region.width / folderFixture.width;
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  const offset = fromFolder ? -30 : 20;
  await page.mouse.move(region.x + region.width + offset * scale, region.y + region.height + offset * scale, { steps: 15 });
  await expect(target).toHaveClass(/folder-drop-preview/);
  await expect.poll(async () => (await target.boundingBox())!.width).toBeGreaterThan(region.width);
  expect(state.elements().find(e => e.id === 'folder')!.width).toBe(folderFixture.width);
  if (fromFolder) {
    await expect(page.locator('.react-flow__node[data-id="element:source"]')).toHaveClass(/folder-drop-preview/);
    expect(state.elements().find(e => e.id === 'source')!.width).toBe(400);
  }
  // Back out without releasing: previews revert and nothing is persisted.
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 10 });
  await expect(target).not.toHaveClass(/folder-drop-preview/);
  await expect.poll(async () => Math.round((await target.boundingBox())!.width)).toBe(Math.round(region.width));
  expect(state.patchCalls()).toBe(0);
  await page.mouse.move(region.x + region.width + offset * scale, region.y + region.height + offset * scale, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => state.elements().find(e => e.id === 'folder')!.width).toBeGreaterThan(folderFixture.width);
  await expect.poll(() => state.elements().find(e => e.id === 'folder')!.height).toBeGreaterThan(folderFixture.height);
  await expect(targetLabel.getByLabel('포함된 파일 2개')).toBeVisible();
  if (fromFolder) {
    await expect(page.locator('.react-flow__node-toolbar[data-id="element:source"]').getByLabel('포함된 파일 0개')).toHaveText('0');
    await expect.poll(() => state.elements().find(e => e.id === 'source')!.width).toBe(320);
  }
  const enlarged = { ...state.elements().find(e => e.id === 'folder')! };
  const moved = { ...state.positions().find(p => p.document_id === 'doc-1')! };
  if (!fromFolder) {
    // A failed folder save must keep the undo entry available for a retry.
    let failOnce = true;
    await page.route('**/canvas/elements/folder', async route => {
      if (failOnce) { failOnce = false; await route.fulfill({ status: 503, json: { detail: '폴더 저장 실패' } }); }
      else await route.fallback();
    });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '되돌리기에 실패했습니다' })).toBeVisible();
    await expect(page.getByRole('button', { name: '다시 실행', exact: true })).toBeDisabled();
  }
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => state.elements().find(e => e.id === 'folder')!.width).toBe(folderFixture.width);
  await expect.poll(() => state.positions().find(p => p.document_id === 'doc-1')).toEqual(origin);
  await expect(targetLabel.getByLabel('포함된 파일 1개')).toBeVisible();
  if (fromFolder) await expect.poll(() => state.elements().find(e => e.id === 'source')!.width).toBe(400);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect.poll(() => state.elements().find(e => e.id === 'folder')).toEqual(enlarged);
  await expect.poll(() => state.positions().find(p => p.document_id === 'doc-1')).toEqual(moved);
  if (fromFolder) await expect.poll(() => state.elements().find(e => e.id === 'source')!.width).toBe(320);
  await page.screenshot({ path: `/tmp/context-folder-drop-${fromFolder ? 'transfer' : 'outside'}-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
  await expect(targetLabel.getByLabel('포함된 파일 2개')).toBeVisible();
  expect(state.positions().find(p => p.document_id === 'doc-0')).toEqual({ document_id: 'doc-0', x: 500, y: -150 });
});

test("folder bottom name persists and semantic zoom restores enclosed files", async ({ page }, info) => {
  const state = await prepare(page, "OWNER", false, [{ ...folderFixture }]);
  const folder = page.locator('.react-flow__node-toolbar[data-id="element:folder"]');
  for (let i = 0; i < 8 && !await folder.locator(".folder-label").count(); i++) await page.getByRole("button", { name: "확대", exact: true }).click();
  await expect(folder.getByLabel('포함된 파일 1개')).toBeVisible();
  await folder.locator('.folder-name').click();
  await folder.getByRole('textbox', { name: '폴더 이름', exact: true }).fill('제품 기획');
  await expect.poll(() => state.elements()[0].text).toBe('제품 기획');
  await page.getByRole('button', { name: '캔버스 수정 완료', exact: true }).click();
  const zoomOut = page.getByRole('button', { name: '축소', exact: true });
  for (let i = 0; i < 6 && await zoomOut.isEnabled(); i++) await zoomOut.click();
  const open = page.getByRole('button', { name: '제품 기획 폴더 펼치기', exact: true });
  await expect(open).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="doc-0"] .paper-sheet')).toBeHidden();
  await expect(page.locator('.react-flow__node[data-id="doc-1"] .paper-sheet')).toBeVisible();
  const label = await open.boundingBox();
  const region = await page.locator('.react-flow__node[data-id="element:folder"]').boundingBox();
  expect(label?.height).toBeGreaterThan(17);
  await expect(open.locator('.folder-name')).toBeVisible();
  expect(label!.x).toBeGreaterThanOrEqual(region!.x);
  expect(label!.y).toBeGreaterThanOrEqual(region!.y);
  expect(label!.x + label!.width).toBeLessThanOrEqual(region!.x + region!.width + 1);
  expect(label!.y + label!.height).toBeLessThanOrEqual(region!.y + region!.height + 1);
  await page.screenshot({ path: `/tmp/context-folder-overview-${info.project.name}.png` });
  await page.getByRole('button', { name: '영역 선택', exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="doc-0"] .paper-sheet')).toBeVisible();
  await page.getByRole('button', { name: '영역 선택 종료', exact: true }).click();
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.locator('.react-flow__node[data-id="doc-0"] .paper-sheet')).toBeVisible();
  await expect(open).toHaveCount(0);
  await expect.poll(async () => {
    const label = await folder.locator('.folder-label').boundingBox();
    const region = await page.locator('.react-flow__node[data-id="element:folder"]').boundingBox();
    return !!label && !!region && label.x >= region.x && label.y >= region.y && label.x + label.width <= region.x + region.width + 1 && label.y + label.height <= region.y + region.height + 1;
  }).toBe(true);
  await page.screenshot({ path: `/tmp/context-folder-detail-${info.project.name}.png` });
  await page.reload();
  await expect(folder.locator('.folder-name')).toHaveText('제품 기획');
  const restored = folder.getByRole('button', { name: '제품 기획 폴더 펼치기' });
  if (await restored.count()) await restored.click();
  await expect(folder.getByLabel('포함된 파일 1개')).toBeVisible();
});

test("overlapping folders assign files once and resize updates membership", async ({ page }) => {
  const state = await prepare(page, 'OWNER', false, [{ ...folderFixture, text: '큰 폴더' }, { ...folderFixture, id: 'small', text: '작은 폴더', width: 400, height: 450 }]);
  const large = page.locator('.react-flow__node-toolbar[data-id="element:folder"]');
  const small = page.locator('.react-flow__node-toolbar[data-id="element:small"]');
  for (let i = 0; i < 8 && !await small.locator(".folder-label").count(); i++) await page.getByRole("button", { name: "확대", exact: true }).click();
  await expect(large.getByLabel('포함된 파일 1개')).toBeVisible();
  await expect(small.getByLabel('포함된 파일 1개')).toHaveText('1');
  await small.locator('.folder-name').click();
  await page.getByLabel('요소 너비', { exact: true }).fill('200');
  await expect.poll(() => state.elements()[1].width).toBe(200);
  await expect(small.getByLabel('포함된 파일 0개')).toHaveText('0');
  await expect(large.getByLabel('포함된 파일 2개')).toBeVisible();
  await page.getByRole('button', { name: '요소 삭제', exact: true }).click();
  await expect(page.locator('.react-flow__node-document')).toHaveCount(2);
});

test("viewer can explore a folder and search its files without changing data", async ({ page }) => {
  const state = await prepare(page, 'VIEWER', false, [{ ...folderFixture, text: '공유 폴더' }]);
  const zoomOut = page.getByRole('button', { name: '축소', exact: true });
  for (let i = 0; i < 6 && await zoomOut.isEnabled(); i++) await zoomOut.click();
  await expect(page.getByRole('button', { name: '공유 폴더 폴더 펼치기', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '문서 검색', exact: true }).fill('공유 폴더');
  await expect(page.locator('.react-flow__node[data-id="doc-0"] .paper-sheet')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="doc-1"] .paper-sheet')).toBeHidden();
  await page.getByRole('textbox', { name: '문서 검색', exact: true }).fill('');
  await page.getByRole('button', { name: '공유 폴더 폴더 펼치기', exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="doc-0"] .paper-sheet')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '폴더 이름', exact: true })).toHaveCount(0);
  expect(state.mutations()).toBe(0);
});

test("basic shapes stay behind cards, resize, recolor, reload and delete", async ({ page }, info) => {
  const state = await prepare(page);
  for (const name of ["사각형", "타원", "삼각형"]) {
    await page.getByRole("button", { name: name === "사각형" ? "사각형 폴더 추가" : `${name} 배경 추가` }).click();
    await expect.poll(() => state.elements().length).toBe(["사각형", "타원", "삼각형"].indexOf(name) + 1);
  }
  await page.getByLabel("요소 너비", { exact: true }).fill("500");
  await page.getByLabel("요소 높이", { exact: true }).fill("350");
  await page.getByRole("button", { name: "초록 색상" }).click();
  await expect.poll(() => state.elements()[2].width).toBe(500);
  await expect(page.locator('.react-flow__node-decoration').last()).toHaveCSS("width", "500px");
  const shapeZ = await page.locator('.react-flow__node-decoration').last().evaluate(el => Number(getComputedStyle(el).zIndex));
  const docZ = await page.locator('.react-flow__node-document').evaluate(el => Number(getComputedStyle(el).zIndex));
  expect(shapeZ).toBeLessThan(docZ);
  await page.screenshot({ path: `/tmp/canvas-shapes-${info.project.name}.png` });
  await page.getByRole("button", { name: "요소 삭제", exact: true }).click();
  await expect.poll(() => state.elements().length).toBe(2);
  await page.reload();
  for (let i = 0; i < 8 && await page.locator('.react-flow__node-decoration').count() < 2; i++) await page.getByRole('button', { name: '확대', exact: true }).click();
  await expect(page.locator('.react-flow__node-decoration')).toHaveCount(2);
  await page.locator('.react-flow__node-document').click();
  await expect(page.getByRole("dialog", { name: "계획서" })).toBeVisible();
});

test("failed save preserves newer text and explicit retry persists it", async ({ page }) => {
  const state = await prepare(page, "OWNER", true);
  await page.getByRole("button", { name: "텍스트 추가", exact: true }).click();
  await page.getByRole("textbox", { name: "캔버스 텍스트 내용" }).fill("실패해도 남는 생각");
  await expect(page.locator(".canvas-notices [role=alert]")).toContainText("잠시 저장할 수 없습니다");
  await expect(page.getByRole("textbox", { name: "캔버스 텍스트 내용" })).toHaveValue("실패해도 남는 생각");
  await page.getByRole("button", { name: "텍스트·도형 저장 재시도" }).click();
  await expect.poll(() => state.elements()[0].text).toBe("실패해도 남는 생각");
  await page.reload();
  await expect(page.getByText("실패해도 남는 생각", { exact: true })).toBeVisible();
});

test("viewer reads elements without editing tools or resizers", async ({ page }) => {
  const state = await prepare(page, "VIEWER");
  await expect(page.getByText("읽기 전용 메모", { exact: true })).toBeVisible();
  await page.locator('.react-flow__node-decoration').click();
  await expect(page.getByRole("toolbar", { name: "텍스트와 배경 도형" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "캔버스 텍스트 내용" })).toHaveCount(0);
  await expect(page.locator('.react-flow__resize-control')).toHaveCount(0);
  expect(state.mutations()).toBe(0);
});


test("leaving edit mode hides text editing and saves pending changes", async ({ page }) => {
  const state = await prepare(page);
  await page.getByRole("button", { name: "텍스트 추가", exact: true }).click();
  await page.getByRole("textbox", { name: "캔버스 텍스트 내용" }).fill("수정 완료 후에도 저장");
  await page.getByRole("button", { name: "캔버스 수정 완료" }).click();
  await expect(page.getByRole("textbox", { name: "캔버스 텍스트 내용" })).toHaveCount(0);
  await expect(page.locator('.react-flow__resize-control')).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "텍스트·도형 편집" })).toHaveCount(0);
  await expect.poll(() => state.elements()[0].text).toBe("수정 완료 후에도 저장");
  await page.locator('.react-flow__node-decoration').click();
  await expect(page.getByRole("textbox", { name: "캔버스 텍스트 내용" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("수정 완료 후에도 저장", { exact: true })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "텍스트와 배경 도형" })).toHaveCount(0);
});


for (const count of [0, 7, 8, 9, 32]) test(`folder projection caps ${count} direct children and round trips without modifying saved geometry`, () => {
  const items = [{ id: 'element:folder', x: 0, y: 0, width: 2000, height: 1800, folder: true }, ...Array.from({ length: count }, (_, i) => ({ id: `doc-${i}`, x: 80 + i % 8 * 220, y: 100 + Math.floor(i / 8) * 335, width: 200, height: 290 }))];
  const saved = JSON.stringify(items), result = projectFolders(items), folder = result.projected.get('element:folder')!;
  expect(folder.width).toBeLessThanOrEqual(1093); expect(folder.height).toBeLessThanOrEqual(793);
  if (count >= 8) { expect(folder.width).toBe(1093); expect(folder.height).toBe(793); }
  for (const item of items.slice(1)) {
    const box = result.projected.get(item.id)!;
    expect(result.canonical(item.id, box)).toEqual({ x: item.x, y: item.y });
    expect(box.x).toBeGreaterThanOrEqual(folder.x); expect(box.y).toBeGreaterThanOrEqual(folder.y);
    expect(box.x + box.width).toBeLessThanOrEqual(folder.x + folder.width + .001);
    expect(box.y + box.height).toBeLessThanOrEqual(folder.y + folder.height + .001);
    const point = result.into('element:folder', { x: folder.x + folder.width, y: folder.y + folder.height });
    expect(point.x + 200).toBeLessThanOrEqual(2000); expect(point.y + 290).toBeLessThanOrEqual(1800);
  }
  expect(JSON.stringify(items)).toBe(saved);
});

test('capped folder keeps visible files editable, centres one toolbar and persists scaled moves', async ({ page }, info) => {
  const state = await prepare(page, 'OWNER', false, [{ ...folderFixture, x: 0, y: 0, width: 2000, height: 1800, text: '정리할 자료' }], 32);
  const label = page.locator('.react-flow__node-toolbar[data-id="element:folder"]');
  if (await label.getByRole('button', { name: '정리할 자료 폴더 펼치기' }).count()) {
    await page.getByRole('button', { name: '캔버스 수정 완료' }).click();
    await label.getByRole('button', { name: '정리할 자료 폴더 펼치기' }).click();
  } else await page.getByRole('button', { name: '캔버스 수정 완료' }).click();
  const file = page.locator('.react-flow__node[data-id="doc-0"]');
  await expect(file).toBeVisible();
  const beforeBox = (await page.locator('.react-flow__node[data-id="element:folder"]').boundingBox())!;
  const view = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
  await expect(file).toBeVisible();
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', view!);
  const afterBox = (await page.locator('.react-flow__node[data-id="element:folder"]').boundingBox())!;
  expect(afterBox.width).toBeCloseTo(beforeBox.width, 1); expect(afterBox.height).toBeCloseTo(beforeBox.height, 1);
  await expect(page.locator('.paper-glyph')).toHaveCount(0);
  await expect(page.locator('.paper-kind-icon')).toHaveCount(32);
  await expect(page.locator('.canvas-hint')).toHaveCount(0);
  const controls = (await page.locator('.react-flow__controls').boundingBox())!;
  const tools = (await page.getByRole('toolbar', { name: '텍스트와 배경 도형' }).boundingBox())!;
  expect(Math.abs(controls.y - tools.y)).toBeLessThan(4); expect(tools.x).toBeGreaterThan(controls.x);
  const dock = (await page.getByRole('toolbar', { name: '캔버스 도구', exact: true }).boundingBox())!;
  const main = (await page.locator('.workspace-main').boundingBox())!;
  const sidebar = info.project.name === 'mobile' ? 80 : 242;
  expect(Math.abs(dock.x + dock.width / 2 - (main.x + sidebar + (main.width - sidebar) / 2))).toBeLessThan(2);
  const origin = { ...state.positions().find(point => point.document_id === 'doc-0')! };
  const paper = (await file.locator('.paper-sheet').boundingBox())!;
  await page.mouse.move(paper.x + paper.width / 2, paper.y + paper.height / 2); await page.mouse.down();
  await page.mouse.move(paper.x + paper.width / 2 + 12, paper.y + paper.height / 2 + 10, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => state.positions().find(point => point.document_id === 'doc-0')!.x).not.toBe(origin.x);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => state.positions().find(point => point.document_id === 'doc-0')!.x).toBe(origin.x);
  await page.screenshot({ path: `/private/tmp/context-capped-web-${info.project.name}.png` });
  await page.reload();
  expect(state.elements()[0].width).toBe(2000); expect(state.elements()[0].height).toBe(1800);
});


test('moving a folder box carries its contents and undo restores the entire group', async ({ page }) => {
  const state = await prepare(page, 'OWNER', false, [{ ...folderFixture, text: '함께 이동' }]);
  const origin = state.positions().map(point => ({ ...point }));
  const folder = page.locator('.react-flow__node[data-id="element:folder"]');
  const box = (await folder.boundingBox())!;
  await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 45, box.y + 35, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => state.positions().find(point => point.document_id === 'doc-0')!.x).not.toBe(origin[0].x);
  expect(state.positions().find(point => point.document_id === 'doc-1')).toEqual(origin[1]);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => state.positions().find(point => point.document_id === 'doc-0')!.x).toBe(origin[0].x);
  await expect.poll(() => state.elements()[0].x).toBe(folderFixture.x);
});

test('nested folder counts once, notes do not consume capacity and hierarchy has no cycles', () => {
  const items = [{ id: 'element:parent', x: 0, y: 0, width: 2000, height: 1800, folder: true },
    { id: 'element:child', x: 0, y: 0, width: 300, height: 400, folder: true },
    { id: 'grandchild', x: 50, y: 50, width: 200, height: 290 },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `file-${i}`, x: 400 + i * 200, y: 500, width: 200, height: 290 }))];
  const result = projectFolders(items);
  expect(result.members.get('element:parent')).toHaveLength(8);
  expect(result.owner.get('grandchild')).toBe('element:child');
  expect(result.projected.get('element:parent')!.width).toBe(1093);
  const file = result.projected.get('grandchild')!, child = result.projected.get('element:child')!;
  expect(file.x).toBeGreaterThanOrEqual(child.x); expect(file.x + file.width).toBeLessThanOrEqual(child.x + child.width);
  expect(result.canonical('grandchild', file)).toEqual({ x: 50, y: 50 });
  const notes = projectFolders([{ id: 'element:notes', x: 0, y: 0, width: 900, height: 700, folder: true }, ...Array.from({ length: 12 }, (_, i) => ({ id: `element:note-${i}`, x: 100, y: 100, width: 200, height: 100 }))]);
  expect(notes.projected.get('element:notes')!.width).toBe(900);
  const equal = projectFolders([{ id: 'element:a', x: 0, y: 0, width: 900, height: 700, folder: true }, { id: 'element:b', x: 0, y: 0, width: 900, height: 700, folder: true }]);
  expect(equal.owner.size).toBe(0);
});

test('trackpad scroll pans in two axes while modifier scroll zooms', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'trackpad behavior is verified on desktop');
  await prepare(page);
  const view = () => page.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
  const before = await view();
  await page.mouse.move(1000, 500); await page.mouse.wheel(100, 60);
  await expect.poll(async () => (await view()).x).toBeLessThan(before.x - 50);
  await expect.poll(async () => (await view()).y).toBeLessThan(before.y - 30);
  expect((await view()).zoom).toBeCloseTo(before.zoom, 5);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -160); await page.keyboard.up('Control');
  await expect.poll(async () => (await view()).zoom).toBeGreaterThan(before.zoom);
});

test('nested folders reveal one level at a time on click in edit mode and hover keeps geometry', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const initial = [
    { ...folderFixture, id: 'outer', text: '바깥', x: 0, y: 0, width: 2000, height: 2000 },
    { ...folderFixture, id: 'inner', text: '중간', x: 100, y: 100, width: 1200, height: 1200 },
    { ...folderFixture, id: 'deep', text: '안쪽', x: 200, y: 200, width: 700, height: 700 },
    { ...folderFixture, id: 'background', kind: 'ellipse', text: '', x: 1000, y: 1100, width: 100, height: 100 },
  ];
  const state = await prepare(page, 'OWNER', false, initial);
  state.positions()[0].x = 300; state.positions()[0].y = 300;
  state.positions()[1].x = 1700; state.positions()[1].y = 1700;
  await page.reload();
  await expect(page.getByLabel('문서 캔버스', { exact: true })).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '캔버스 수정', exact: true }).click();
  const outer = page.getByRole('button', { name: '바깥 폴더 펼치기', exact: true });
  for (let i = 0; i < 6 && !await outer.count(); i++) await page.getByRole('button', { name: '축소', exact: true }).click();
  await expect(outer).toBeVisible();
  await expect(outer.locator('svg,.folder-count')).toHaveCount(0);
  const region = page.locator('.react-flow__node[data-id="element:outer"]');
  const before = (await region.boundingBox())!;
  await outer.hover();
  await expect.poll(async () => JSON.stringify(await region.boundingBox())).toBe(JSON.stringify(before));
  await outer.click();
  const inner = page.getByRole('button', { name: '중간 폴더 펼치기', exact: true });
  await expect(inner).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="doc-0"]')).toHaveCount(0);
  await inner.click();
  const deep = page.getByRole('button', { name: '안쪽 폴더 펼치기', exact: true });
  await expect(deep).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="doc-0"]')).toHaveCount(0);
  if (info.project.name === 'mobile') {
    const box = (await deep.boundingBox())!;
    await page.mouse.move(350, 550); await page.mouse.wheel(box.x + box.width / 2 - 240, box.y + box.height / 2 - 430);
  }
  await deep.click();
  await expect(page.locator('.react-flow__node[data-id="doc-0"] .paper-sheet')).toBeVisible();
  await expect(page.getByRole('button', { name: '확대', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '캔버스 수정 완료', exact: true })).toBeVisible();
  await page.screenshot({ path: `/tmp/context-nested-motion-${info.project.name}.png` });
});

test('text overlays preserve every position and new empty folders use local animated placement with undo', async ({ page }) => {
  const state = await prepare(page);
  const original = structuredClone(state.positions());
  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  await page.getByRole('textbox', { name: '캔버스 텍스트 내용' }).fill('겹쳐 놓는 메모');
  await page.getByRole('button', { name: '요소 선택 해제' }).click();
  expect(state.positions()).toEqual(original);
  await page.getByRole('button', { name: '사각형 폴더 추가', exact: true }).click();
  await expect.poll(() => state.elements().filter(e => e.kind === 'rectangle').length).toBe(1);
  const created = state.elements().find(e => e.kind === 'rectangle')!;
  expect(created.width).toBe(320); expect(created.height).toBe(240);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
  const after = structuredClone(state.positions());
  for (const point of after) {
    const before = original.find(p => p.document_id === point.document_id)!;
    expect(point.y).toBe(before.y); expect(Math.abs(point.x - before.x)).toBeLessThanOrEqual(160);
  }
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect.poll(() => state.positions()).toEqual(original);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect.poll(() => state.positions()).toEqual(after);
  await page.reload();
  await expect(page.getByText('겹쳐 놓는 메모', { exact: true })).toBeVisible();
  expect(state.positions()).toEqual(after);
});

test('failed insertion compensates layout and keeps the created folder available without a false undo entry', async ({ page }) => {
  const state = await prepare(page);
  const before = structuredClone(state.positions());
  let failOnce = true;
  await page.route('**/canvas/elements/*', async route => {
    if (route.request().method() === 'PATCH' && failOnce) { failOnce = false; await route.fulfill({ status: 503, json: { detail: '배치 저장 실패' } }); }
    else await route.fallback();
  });
  await page.getByRole('button', { name: '사각형 폴더 추가', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '추가한 항목의 배치를 저장하지 못했습니다' })).toBeVisible();
  await expect.poll(() => state.elements().filter(e => e.kind === 'rectangle').length).toBe(1);
  expect(state.positions()).toEqual(before);
  await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.locator('.react-flow__node-decoration')).toHaveCount(1);
  expect(state.positions()).toEqual(before);
});
