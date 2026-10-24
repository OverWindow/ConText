import { expect, test, type Page } from "@playwright/test";

const workspaceId = "00000000-0000-0000-0000-000000000002";
type Coordinate = { document_id: string; x: number; y: number };
type Relation = { id: string; source_document_id: string; target_document_id: string; relation_type: string; source_handle?: string; target_handle?: string };

async function prepare(page: Page, role = "OWNER", failSave = false, formats = ["pdf", "pdf"], withRelation = false, failDelete = false, ready = false) {
  const user = { id: "00000000-0000-0000-0000-000000000001", email: "test@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: "authenticated" })}.test-signature`;
  await page.context().addCookies([{ name: "sb-127-auth-token", value: "base64-" + encode({ access_token: token, refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user }), domain: "localhost", path: "/" }]);
  const documents = formats.map((format, i) => i < 2 ? ["Research", "Proposal"][i] : `Sample ${format}`).map((title, i) => ({ id: `doc-${i}`, workspace_id: workspaceId, title, current_version_id: `version-${i}`, created_at: "2026-10-07T00:00:00Z", versions: [{ id: `version-${i}`, document_id: `doc-${i}`, version_number: 1, original_filename: `${title}.${formats[i]}`, mime_type: "application/pdf", size: 123, sha256: "a".repeat(64), status: ready ? "READY" : "UPLOADED" }] }));
  let members = [{ id: "member-1", display_name: "김지우", role: "OWNER" }, { id: "member-2", display_name: "박서연", role: "EDITOR" }];
  let positions: Coordinate[] = [{ document_id: "doc-0", x: 0, y: 0 }, { document_id: "doc-1", x: 390, y: 0 }];
  let relations: Relation[] = withRelation ? [{ id: "relation-1", source_document_id: "doc-0", target_document_id: "doc-1", relation_type: "REFERENCE" }] : [];
  let relationSequence = withRelation ? 1 : 0;
  let deleteCalls = 0;
  let saveCalls = 0;
  const mutations: string[] = [];
  await page.route("http://localhost:3102/api/**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    expect(req.headers().authorization).toBe(`Bearer ${token}`);
    let data: unknown;
    if (req.method() !== "GET") mutations.push(req.method());
    if (path.endsWith("/canvas/positions")) {
      saveCalls++;
      if (failSave && saveCalls === 1) { await route.fulfill({ status: 503, json: { detail: "Storage temporarily unavailable" } }); return; }
      const changes: Coordinate[] = req.postDataJSON().positions;
      positions = [...positions.filter(p => !changes.some(c => c.document_id === p.document_id)), ...changes]; data = changes;
    } else if (path.endsWith("/relations") && req.method() === "POST") {
      const body = req.postDataJSON();
      const existing = relations.find(item => item.source_document_id === body.source_document_id && item.target_document_id === body.target_document_id && item.relation_type === body.relation_type);
      const relation = { id: existing?.id || `relation-${++relationSequence}`, ...body }; relations = [relation]; data = relation;
    } else if (path.includes("/relations/relation-") && req.method() === "DELETE") {
      deleteCalls++;
      if (failDelete && deleteCalls === 1) { await route.fulfill({ status: 503, json: { detail: "연결을 삭제하지 못했습니다. 다시 시도해 주세요." } }); return; }
      if (!relations.some(item => path.endsWith("/" + item.id))) { await route.fulfill({ status: 404, json: { detail: "연결이 없습니다." } }); return; }
      relations = []; await route.fulfill({ status: 204 }); return;
    } else if (path.endsWith("/canvas")) data = { documents, positions, relations };
    else if (path.endsWith("/members")) {
      if (req.method() === "POST") { const body = req.postDataJSON(); expect(body).toEqual({ email: "new@example.test", role: "EDITOR" }); const added = { id: "new-member", display_name: "이서준", role: body.role }; members = [...members, added]; data = added; }
      else data = members;
    }
    else if (path.endsWith("/processing")) data = { state: "QUEUED", summary: null, error_message: null };
    else if (path.endsWith("/documents")) data = documents;
    else if (path.includes("/api/documents/")) data = documents.find(doc => path.endsWith("/" + doc.id));
    else data = { id: workspaceId, name: "Research workspace", role };
    await route.fulfill({ json: data });
  });
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.locator('.react-flow__node[data-id="doc-0"]')).toBeVisible();
  return { documents, positions: () => positions, relations: () => relations, saveCalls: () => saveCalls, mutations };
}

async function editCanvas(page: Page) {
  const button = page.getByRole("button", { name: "캔버스 수정", exact: true });
  if (await button.count()) await button.click();
}
async function connectCards(page: Page) {
  const source = page.locator('.react-flow__node[data-id="doc-0"] .react-flow__handle-right');
  const target = page.locator('.react-flow__node[data-id="doc-1"] .react-flow__handle-left');
  await expect(source).toBeVisible();
  const from = await source.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error("Missing handles");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 }); await page.mouse.up();
}

test("all four sides connect and chosen endpoints survive reload", async ({ page }, info) => {
  const state = await prepare(page);
  for (const [sourceSide, targetSide] of [['bottom', 'top'], ['top', 'bottom'], ['left', 'right']]) {
    await editCanvas(page);
    const fromNode = page.locator('.react-flow__node[data-id="doc-0"]');
    const toNode = page.locator('.react-flow__node[data-id="doc-1"]');
    const from = await fromNode.locator(`[data-handleid="${sourceSide}"]`).boundingBox();
    const to = await toNode.locator(`[data-handleid="${targetSide}"]`).boundingBox();
    if (!from || !to) throw new Error('Missing connection handles');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => state.relations()[0]).toMatchObject({ source_document_id: 'doc-0', target_document_id: 'doc-1', source_handle: sourceSide, target_handle: targetSide });
    await page.reload();
    await editCanvas(page);
    const path = page.locator('.react-flow__edge[data-id="relation-1"] .react-flow__edge-path');
    await expect(path).toHaveAttribute('d', /^M/);
    const endpoints = await path.evaluate(el => {
      const curve = el as SVGPathElement;
      const matrix = curve.getScreenCTM()!;
      const start = curve.getPointAtLength(0), end = curve.getPointAtLength(curve.getTotalLength());
      const a = new DOMPoint(start.x, start.y).matrixTransform(matrix), b = new DOMPoint(end.x, end.y).matrixTransform(matrix);
      return { start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y } };
    });
    const source = await fromNode.locator(`[data-handleid="${sourceSide}"]`).boundingBox();
    const target = await toNode.locator(`[data-handleid="${targetSide}"]`).boundingBox();
    if (!source || !target) throw new Error('Missing restored endpoints');
    expect(Math.hypot(endpoints.start.x - source.x - source.width / 2, endpoints.start.y - source.y - source.height / 2)).toBeLessThan(12);
    expect(Math.hypot(endpoints.end.x - target.x - target.width / 2, endpoints.end.y - target.y - target.height / 2)).toBeLessThan(12);
    if (sourceSide === 'bottom') await page.screenshot({ path: `/tmp/canvas-vertical-connections-${info.project.name}.png` });
  }
});
async function clickConnection(page: Page) {
  const path = page.locator('.react-flow__edge[data-id="relation-1"] .react-flow__edge-path');
  await expect(path).toHaveAttribute("d", /^M/);
  const point = await path.evaluate(el => {
    const path = el as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
}
async function dragFirst(page: Page) {
  const node = page.locator('.react-flow__node[data-id="doc-0"]');
  await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox();
  if (!box) throw new Error("Missing node");
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 55, box.y + 95, { steps: 12 });
  await page.mouse.up();
}

test("drag saves coordinates, reload restores, zoom and pan work", async ({ page }) => {
  const state = await prepare(page);
  await editCanvas(page);
  await dragFirst(page);
  await expect.poll(() => state.saveCalls()).toBeGreaterThan(0);
  await expect(page.getByText("모든 변경사항 저장됨", { exact: true })).toBeVisible();
  const saved = state.positions().find(p => p.document_id === "doc-0")!;
  expect(saved.x).not.toBe(0); expect(saved.y).not.toBe(0);
  await page.reload();
  const node = page.locator('.react-flow__node[data-id="doc-0"]');
  await expect(node).toBeVisible();
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeCloseTo(saved.x, 2);
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m42)).toBeCloseTo(saved.y, 2);
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.getByRole("button", { name: "확대", exact: true }).click();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) throw new Error("Missing canvas");
  const zoomed = await viewport.getAttribute("style");
  await page.mouse.move(box.x + box.width - 30, box.y + box.height - 65);
  await page.mouse.down(); await page.mouse.move(box.x + box.width - 90, box.y + box.height - 95, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(zoomed);
});

test("failed position save retains changes and retries", async ({ page }) => {
  const state = await prepare(page, "EDITOR", true);
  await editCanvas(page);
  await dragFirst(page);
  await expect(page.getByRole("button", { name: "위치 저장 재시도" })).toBeVisible();
  await expect(page.getByRole("button", { name: "캔버스 새로고침" })).toBeDisabled();
  await page.getByRole("button", { name: "위치 저장 재시도" }).click();
  await expect(page.getByText("모든 변경사항 저장됨", { exact: true })).toBeVisible();
  expect(state.positions().find(p => p.document_id === "doc-0")!.x).not.toBe(0);
});

test("relations persist and delete directly from clicked edge in edit mode", async ({ page }, testInfo) => {
  const state = await prepare(page);
  await editCanvas(page);
  await page.getByLabel("연결 유형", { exact: true }).selectOption("REFERENCE");
  await connectCards(page);
  await expect(page.locator('.react-flow__edge[data-id="relation-1"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('.react-flow__edge[data-id="relation-1"]')).toBeVisible();
  expect(state.relations()).toHaveLength(1);
  await clickConnection(page);
  await expect(page.getByRole("dialog", { name: "연결 옵션" })).toHaveCount(0);
  await editCanvas(page);
  await clickConnection(page);
  const options = page.getByRole("dialog", { name: "연결 옵션" });
  await expect(options).toContainText("Research");
  await expect(options).toContainText("Proposal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/canvas-edit-${testInfo.project.name}.png` });
  await options.getByRole("button", { name: "연결 삭제", exact: true }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect(options).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  expect(state.relations()).toHaveLength(0);
});

test("viewer can explore and select but cannot mutate canvas", async ({ page }) => {
  const state = await prepare(page, "VIEWER", false, ["pdf", "pdf"], true);
  await expect(page.getByRole("button", { name: "캔버스 수정", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("연결 유형", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "되돌리기", exact: true })).toHaveCount(0);
  await dragFirst(page);
  await clickConnection(page);
  await expect(page.getByRole("dialog", { name: "연결 옵션" })).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="doc-0"]').click();
  await expect(page.getByRole("button", { name: "원본 다운로드", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "미리보기 닫기" }).click();
  await page.getByRole("button", { name: "확대", exact: true }).click();
  expect(state.mutations).toEqual([]);
});

test("keyboard movement and handle connections persist", async ({ page }) => {
  const state = await prepare(page);
  await editCanvas(page);
  const node = page.locator('.react-flow__node[data-id="doc-0"]');
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(node).toHaveClass(/selected/);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => state.saveCalls()).toBeGreaterThan(0);
  await expect(page.getByText("모든 변경사항 저장됨", { exact: true })).toBeVisible();
  const source = page.locator('.react-flow__node[data-id="doc-0"] .react-flow__handle-right');
  const target = page.locator('.react-flow__node[data-id="doc-1"] .react-flow__handle-left');
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error("Missing connection handles");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge[data-id="relation-1"]')).toBeVisible();
  expect(state.relations()[0]).toMatchObject({ source_document_id: "doc-0", target_document_id: "doc-1" });
});


test("full viewport mesh, Korean menus, actual members and search", async ({ page }, testInfo) => {
  await prepare(page);
  expect(await page.locator('html').getAttribute('lang')).toBe('ko');
  expect(await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth }))).toEqual(await page.evaluate(() => ({ height: innerHeight, width: innerWidth })));
  const box = await page.locator('.canvas-surface').boundingBox();
  expect(box?.x).toBe(0); expect(box?.y).toBe(0);
  expect(box?.height).toBe(await page.evaluate(() => innerHeight));
  await page.getByLabel('문서 검색').fill('Research');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await page.getByLabel('문서 검색').clear();
  await page.screenshot({ path: `/tmp/phase4-overview-${testInfo.project.name}.png` });
  if (await page.getByRole('button', { name: '메뉴 열기', exact: true }).isVisible()) await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await expect(page.getByText('김지우', { exact: false })).toBeVisible();
  await expect(page.getByText('박서연', { exact: false })).toBeVisible();
});

test("processed text is readable and untrusted markup stays inert", async ({ page }, testInfo) => {
  await prepare(page);
  await page.route('**/api/versions/version-0/processing', route => route.fulfill({ json: { state: 'COMPLETED', error_message: null, summary: { block_count: 3, character_count: 120, page_count: 2 } } }));
  await page.route('**/api/versions/version-0/content', route => route.fulfill({ json: { blocks: [
    { id: 1, type: 'heading', text: '분기 리서치 결과', source: { page: 1 } },
    { id: 2, type: 'paragraph', text: '<script>window.injected = true</script> 한국어 본문이 안전하게 표시됩니다.', source: { page: 1 } },
    { id: 3, type: 'table', text: '항목\t결과', rows: [['항목', '결과'], ['만족도', '높음']], source: { page: 2 } },
  ], total: 3, next_offset: null, warnings: ['이미지 내용은 추출하지 않았습니다.'] } }));
  await page.locator('.react-flow__node[data-id="doc-0"]').click();
  await expect(page.getByRole('heading', { name: '분기 리서치 결과' })).toBeVisible();
  await expect(page.getByText('한국어 본문이 안전하게 표시됩니다.', { exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: '높음' })).toBeVisible();
  expect(await page.evaluate(() => 'injected' in window)).toBeFalsy();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await page.evaluate(() => innerHeight));
  await page.screenshot({ path: `/tmp/phase4-reader-${testInfo.project.name}.png` });
});

test("processing failure explains the cause and allows an editor retry", async ({ page }) => {
  await prepare(page, 'EDITOR');
  let retried = false;
  await page.route('**/api/versions/version-0/processing', route => route.fulfill({ json: { state: retried ? 'QUEUED' : 'FAILED', summary: null, error_message: '스캔 PDF는 OCR 처리가 필요합니다.' } }));
  await page.route('**/api/versions/version-0/process', route => { retried = true; return route.fulfill({ status: 202, json: { state: 'QUEUED' } }); });
  await page.locator('.react-flow__node[data-id="doc-0"]').click();
  await expect(page.getByText('스캔 PDF는 OCR 처리가 필요합니다.')).toBeVisible();
  await page.getByRole('button', { name: '다시 처리', exact: true }).click();
  await expect(page.getByText('문서 처리 대기 중', { exact: true })).toBeVisible();
  expect(retried).toBeTruthy();
});

test("file formats have distinct accents and document click opens centered modal", async ({ page }, testInfo) => {
  await prepare(page, 'OWNER', false, ['pdf', 'docx', 'hwpx', 'txt', 'MD']);
  const colors = await page.locator('.canvas-document').evaluateAll(cards => cards.map(card => getComputedStyle(card).getPropertyValue("--paper-accent")));
  expect(new Set(colors).size).toBe(5);
  await expect(page.locator('.file-theme-md .canvas-file-kind')).toContainText('마크다운');
  if (testInfo.project.name === 'desktop') { const sidebar = await page.locator('.sidebar').boundingBox(); for (const card of await page.locator('.canvas-document').all()) { const bounds = await card.boundingBox(); expect(bounds!.x).toBeGreaterThan(sidebar!.x + sidebar!.width); } }
  await page.locator('.react-flow__node[data-id="doc-0"]').click();
  const preview = page.getByRole('dialog', { name: 'Research', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByText('문서 처리 대기 중', { exact: true })).toBeVisible();
  const box = await preview.boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  await page.screenshot({ path: `/tmp/document-preview-${testInfo.project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await page.screenshot({ path: `/tmp/file-colors-${testInfo.project.name}.png` });
});

test("reference labels can be hidden without deleting connections", async ({ page }) => {
  const state = await prepare(page);
  await editCanvas(page);
  await connectCards(page);
  await expect(page.locator('.react-flow__edge-text')).toHaveText('참조');
  await page.getByLabel('연결선 표시', { exact: true }).uncheck();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.getByLabel('연결선 표시', { exact: true }).check();
  await page.getByRole('button', { name: '캔버스 수정 완료' }).click();
  await page.getByRole('button', { name: '참조 표시 숨기기', exact: true }).click();
  await expect(page.locator('.react-flow__edge-text')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  expect(state.relations()).toHaveLength(1);
  await page.getByRole('button', { name: '참조 표시 보이기', exact: true }).click();
  await expect(page.locator('.react-flow__edge-text')).toHaveText('참조');
});

test("owner adds teammate and list updates; editor cannot see add action", async ({ page }) => {
  await prepare(page);
  if (await page.getByRole('button', { name: '메뉴 열기', exact: true }).isVisible()) await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await page.getByRole('button', { name: '팀원 추가', exact: true }).click();
  await page.getByLabel('팀원 이메일').fill('new@example.test');
  await page.getByLabel('팀원 권한').selectOption('EDITOR');
  await page.getByRole('button', { name: '팀원 추가하기' }).click();
  await expect(page.getByRole('status').filter({ hasText: '이서준' })).toBeVisible();
  await page.getByRole('button', { name: '팀원 추가 닫기' }).click();
  if (await page.getByRole('button', { name: '메뉴 열기', exact: true }).isVisible()) await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await expect(page.locator('.member-list')).toContainText('이서준');
  await page.reload();
  await expect(page.locator('.member-list')).toContainText('이서준');
  await prepare(page, 'EDITOR');
  await expect(page.getByRole('button', { name: '팀원 추가', exact: true })).toHaveCount(0);
});


test("browse mode prevents movement, hides tools and removes old connection menu", async ({ page }, info) => {
  const state = await prepare(page);
  await expect(page.getByRole("button", { name: /^문서 연결/ })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "텍스트와 배경 도형" })).toHaveCount(0);
  const node = page.locator('.react-flow__node[data-id="doc-0"]');
  await node.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("ArrowRight");
  await dragFirst(page);
  expect(state.mutations).toEqual([]);
  await editCanvas(page);
  await expect(page.getByRole("toolbar", { name: "텍스트와 배경 도형" })).toBeVisible();
  await expect(page.getByRole("button", { name: "캔버스 수정 완료" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `/tmp/context-edit-mode-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole("button", { name: "캔버스 수정 완료" }).click();
  await expect(page.getByRole("toolbar", { name: "텍스트와 배경 도형" })).toHaveCount(0);
  await expect(page.getByLabel("연결 유형", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "되돌리기", exact: true })).toBeDisabled();
  await page.screenshot({ path: `/tmp/context-browse-mode-${info.project.name}.png`, animations: 'disabled' });
});

test("edge options close on escape, outside and edit exit; failed deletion retries", async ({ page }) => {
  const state = await prepare(page, "OWNER", false, ["pdf", "pdf"], true, true);
  await editCanvas(page);
  const options = page.getByRole("dialog", { name: "연결 옵션" });
  await clickConnection(page); await expect(options).toBeVisible();
  await page.keyboard.press("Escape"); await expect(options).toHaveCount(0);
  await clickConnection(page); await page.getByRole("button", { name: "참조 표시 숨기기" }).click();
  await expect(options).toHaveCount(0);
  await clickConnection(page); await expect(options).toBeVisible();
  await page.getByRole("button", { name: "캔버스 수정 완료" }).click();
  await expect(options).toHaveCount(0);
  await editCanvas(page); await clickConnection(page);
  await options.getByRole("button", { name: "연결 삭제", exact: true }).click();
  await expect(options.getByRole("alert")).toContainText("다시 시도");
  expect(state.relations()).toHaveLength(1);
  await options.getByRole("button", { name: "연결 삭제", exact: true }).click();
  await expect(options).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
});


test("undo and redo file movement persist and a new move clears redo", async ({ page }, info) => {
  const state = await prepare(page);
  const undo = page.getByRole("button", { name: "되돌리기", exact: true });
  const redo = page.getByRole("button", { name: "다시 실행", exact: true });
  await expect(undo).toBeDisabled(); await expect(redo).toBeDisabled();
  await editCanvas(page); await dragFirst(page);
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")!.x).not.toBe(0);
  const moved = { ...state.positions().find(p => p.document_id === "doc-0")! };
  await undo.click();
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")).toEqual({ document_id: "doc-0", x: 0, y: 0 });
  await expect(undo).toBeDisabled(); await expect(redo).toBeEnabled();
  await redo.click();
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")).toEqual(moved);
  await undo.click(); await expect(redo).toBeEnabled();
  await dragFirst(page); await expect(redo).toBeDisabled();
  await expect(undo).toBeEnabled(); await undo.click();
  await expect(redo).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controls = await page.locator('.header-actions button').evaluateAll(buttons => buttons.filter(button => (button as HTMLElement).offsetParent !== null).map(button => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }));
  const width = await page.evaluate(() => innerWidth);
  expect(controls.every(rect => rect.left >= 0 && rect.right <= width)).toBe(true);
  await page.screenshot({ path: `/tmp/context-undo-${info.project.name}.png` });
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="doc-0"]')).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(undo).toBeDisabled();
});

test("undo and redo connections resolve restored server identifiers", async ({ page }) => {
  const state = await prepare(page);
  const undo = page.getByRole("button", { name: "되돌리기", exact: true });
  const redo = page.getByRole("button", { name: "다시 실행", exact: true });
  await editCanvas(page); await connectCards(page);
  await expect.poll(() => state.relations().length).toBe(1);
  await clickConnection(page);
  await page.getByRole("button", { name: "연결 삭제", exact: true }).click();
  await expect.poll(() => state.relations().length).toBe(0);
  await undo.click();
  await expect.poll(() => state.relations()[0]?.id).toBe("relation-2");
  await undo.click(); await expect.poll(() => state.relations().length).toBe(0);
  await redo.click(); await expect.poll(() => state.relations()[0]?.id).toBe("relation-3");
  await redo.click(); await expect.poll(() => state.relations().length).toBe(0);
  await undo.click(); await expect.poll(() => state.relations()[0]?.id).toBe("relation-4");
  await page.reload(); await expect(page.locator('.react-flow__edge[data-id="relation-4"]')).toBeVisible();
});

test("failed undo can retry and keyboard shortcuts leave text inputs alone", async ({ page }) => {
  const state = await prepare(page);
  await editCanvas(page); await dragFirst(page);
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")!.x).not.toBe(0);
  let fail = true;
  await page.route('**/canvas/positions', async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { detail: "일시적인 저장 오류입니다." } }); }
    else await route.fallback();
  });
  const undo = page.getByRole("button", { name: "되돌리기", exact: true });
  await undo.click();
  await expect(page.getByRole("alert").filter({ hasText: "되돌리기에 실패했습니다" })).toBeVisible();
  await expect(undo).toBeEnabled(); await undo.click();
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")!.x).toBe(0);
  await expect(page.getByRole("button", { name: "다시 실행", exact: true })).toBeEnabled();
  const search = page.getByLabel("문서 검색");
  await search.fill("Research"); await search.press("Control+Shift+z");
  expect(state.positions().find(p => p.document_id === "doc-0")!.x).toBe(0);
  await search.clear();
  await page.getByRole("button", { name: "다시 실행", exact: true }).focus();
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")!.x).not.toBe(0);
  await expect(undo).toBeEnabled(); await undo.focus(); await page.keyboard.press("Control+z");
  await expect.poll(() => state.positions().find(p => p.document_id === "doc-0")!.x).toBe(0);
});


test("undo restores previous connection sides", async ({ page }) => {
  const state = await prepare(page, "OWNER", false, ["pdf", "pdf"], true);
  await editCanvas(page);
  const source = await page.locator('.react-flow__node[data-id="doc-0"] [data-handleid="bottom"]').boundingBox();
  const target = await page.locator('.react-flow__node[data-id="doc-1"] [data-handleid="top"]').boundingBox();
  if (!source || !target) throw new Error("Missing handles");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => state.relations()[0]).toMatchObject({ source_handle: "bottom", target_handle: "top" });
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => state.relations()[0]).toMatchObject({ source_handle: "right", target_handle: "left" });
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  await expect.poll(() => state.relations()[0]).toMatchObject({ source_handle: "bottom", target_handle: "top" });
  expect(state.relations()).toHaveLength(1);
});


async function selectFileArea(page: Page, touch: boolean) {
  await page.locator(".react-flow__controls").getByRole("button", { name: "영역 선택", exact: true }).click();
  for (const id of ['doc-0', 'doc-1']) {
    await expect(page.locator(`.react-flow__node[data-id="${id}"] .paper-sheet`)).toBeVisible();
    await expect(page.locator(`.react-flow__node[data-id="${id}"] .paper-caption`)).toBeVisible();
  }
  // Fit both cards inside the usable canvas before drawing a full enclosure.
  await page.getByRole("button", { name: "축소", exact: true }).click();
  await page.getByRole("button", { name: "축소", exact: true }).click();
  const first = await page.locator('.react-flow__node[data-id="doc-0"]').boundingBox();
  const second = await page.locator('.react-flow__node[data-id="doc-1"]').boundingBox();
  if (!first || !second) throw new Error("Missing selection targets");
  const from = { x: Math.min(first.x, second.x) - 8, y: Math.min(first.y, second.y) - 8 };
  const to = { x: Math.max(first.x + first.width, second.x + second.width) + 8, y: Math.max(first.y + first.height, second.y + second.height) + 8 };
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
  }
  await expect(page.getByText("2개 파일 선택", { exact: true })).toBeVisible();
  for (const id of ['doc-0', 'doc-1']) {
    await expect(page.locator(`.react-flow__node[data-id="${id}"] .paper-sheet`)).toBeVisible();
    await expect(page.locator(`.react-flow__node[data-id="${id}"] .paper-caption`)).toBeVisible();
  }
}

test("area selection creates a persistent summary file and retries without duplication", async ({ page }, info) => {
  const state = await prepare(page, "OWNER", false, ["pdf", "pdf"], false, false, true);
  const requests: Record<string, unknown>[] = [];
  let lost = true;
  await page.route('**/canvas/summaries', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (lost) { lost = false; await route.fulfill({ status: 503, json: { detail: "요약을 다시 시도해 주세요." } }); return; }
    const document = { ...state.documents[0], id: 'summary', title: '문서 2개 요약', current_version_id: 'summary-version', versions: [{ ...state.documents[0].versions[0], id: 'summary-version', document_id: 'summary', original_filename: '문서 2개 요약.md', status: 'READY' }] };
    state.documents.push(document);
    state.positions().push({ document_id: 'summary', x: body.x, y: body.y });
    state.relations().push({ id: 'summary-link', source_document_id: 'summary', target_document_id: 'doc-0', relation_type: 'GENERATED_FROM' });
    await route.fulfill({ status: 201, json: { document, x: body.x, y: body.y } });
  });
  await page.route('**/api/versions/summary-version/processing', route => route.fulfill({ json: { state: 'COMPLETED', error_message: null, summary: { block_count: 1, character_count: 30, page_count: null } } }));
  await page.route('**/api/versions/summary-version/content', route => route.fulfill({ json: { blocks: [{ id: 1, type: 'paragraph', text: '선택한 두 파일의 요약 본문입니다.', source: {} }], total: 1, next_offset: null, warnings: [] } }));
  await selectFileArea(page, info.project.name === 'mobile');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  expect(state.mutations).toEqual([]);
  await page.screenshot({ path: `/tmp/context-area-selection-${info.project.name}.png` });
  const summarize = page.getByRole('button', { name: '요약 파일 만들기', exact: true });
  await summarize.click(); await expect(page.getByRole('region', { name: '선택한 파일 작업' }).getByRole('alert')).toContainText('요약을 다시 시도');
  await summarize.click();
  await expect(page.locator('.react-flow__node[data-id="summary"]')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0].request_id).toBe(requests[1].request_id);
  expect(requests[0].version_ids).toEqual(['version-0', 'version-1']);
  await expect(page.getByRole('region', { name: '선택한 파일 작업' })).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="summary"]').click();
  await expect(page.getByText('선택한 두 파일의 요약 본문입니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  await page.screenshot({ path: `/tmp/context-summary-file-${info.project.name}.png` });
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="summary"]')).toContainText('문서 2개 요약.md');
  await expect(page.locator('.react-flow__edge[data-id="summary-link"]')).toBeVisible();
});

test("area selection blocks unprocessed files and escape clears selection", async ({ page }, info) => {
  await prepare(page);
  await selectFileArea(page, info.project.name === 'mobile');
  await expect(page.getByRole('button', { name: '요약 파일 만들기', exact: true })).toBeDisabled();
  await expect(page.getByText('선택한 파일의 본문 처리가 완료되면 요약할 수 있습니다.')).toBeVisible();
  await page.getByRole('button', { name: '영역 선택', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(page.getByLabel('파일 영역 선택', { exact: true })).toHaveCount(0);
});
