import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const versionId = "00000000-0000-0000-0000-000000000003";
const body = Buffer.from("A document for Phase 2\n");
const sha256 = createHash("sha256").update(body).digest("hex");

async function prepare(page: Page, role = "OWNER", pending = false, failComplete = false) {
  const user = { id: "00000000-0000-0000-0000-000000000001", email: "test@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: "authenticated" })}.test-signature`;
  await page.context().addCookies([{ name: "sb-127-auth-token", value: "base64-" + encode({ access_token: token, refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: "bearer", user }), domain: "localhost", path: "/" }]);
  const document = { id: "document-one", workspace_id: workspaceId, title: "notes", current_version_id: pending ? null : versionId, created_at: "2026-10-07T00:00:00Z", versions: [{ id: versionId, document_id: "document-one", version_number: 1, original_filename: "notes.md", mime_type: "text/markdown", size: body.length, sha256, status: pending ? "UPLOADING" : "UPLOADED" }] };
  let exists = pending || role === "VIEWER";
  let completionAttempts = 0;
  let uploaded = false;
  let positions: { document_id: string; x: number; y: number }[] = [];
  await page.route("http://localhost:3102/api/**", async route => {
    const request = route.request();
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    const path = new URL(request.url()).pathname;
    let response: unknown;
    if (path.endsWith("/download-url")) response = { download_url: "http://localhost:3102/storage/download" };
    else if (path.endsWith("/upload-url")) {
      if (path.includes("/workspaces/")) {
        expect(request.postDataJSON()).toMatchObject({ title: "notes", filename: "notes.md", size: body.length, sha256 });
        exists = true; document.versions[0].status = "UPLOADING"; document.current_version_id = null;
      }
      response = { document_id: document.id, version_id: versionId, method: "PUT", upload_url: "http://localhost:3102/storage/upload", headers: { "Content-Type": "text/markdown", "If-None-Match": "*" }, expires_in: 600 };
    } else if (path.endsWith("/upload-complete")) {
      completionAttempts++;
      if (failComplete && completionAttempts === 1) { await route.fulfill({ status: 503, json: { detail: "Unable to verify the uploaded file" } }); return; }
      document.current_version_id = versionId; document.versions[0].status = "UPLOADED";
      response = document;
    } else if (path.endsWith("/members")) response = [{ id: "one", display_name: "김지우", role }];
    else if (path.endsWith("/processing")) response = { state: "QUEUED", summary: null, error_message: null };
    else if (path.endsWith("/duplicates")) response = [];
    else if (path.endsWith("/documents")) response = exists ? [document] : [];
    else if (path.includes("/api/documents/")) response = document;
    else if (path.endsWith("/canvas/positions")) {
      const changes = request.postDataJSON().positions as typeof positions;
      positions = [...positions.filter(p => !changes.some(c => c.document_id === p.document_id)), ...changes]; response = changes;
    }
    else if (path.endsWith("/canvas")) response = { documents: exists ? [document] : [], positions, relations: [] };
    else response = { id: workspaceId, name: "Product documents", role };
    await route.fulfill({ json: response });
  });
  await page.route("http://localhost:3102/storage/**", async route => {
    expect(route.request().headers().authorization).toBeUndefined();
    if (route.request().method() === "PUT") {
      expect(route.request().postDataBuffer()).toEqual(body);
      expect(route.request().headers()["if-none-match"]).toBe("*");
      uploaded = true;
      await route.fulfill({ status: 200, body: "" });
    } else await route.fulfill({ body, headers: { "Content-Disposition": 'attachment; filename="notes.md"' } });
  });
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.locator('.canvas-header')).toBeVisible();
  if (await page.getByRole('button', { name: '메뉴 열기', exact: true }).isVisible()) await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await page.getByRole('button', { name: '문서 관리', exact: true }).click();
  await expect(page.getByRole('heading', { name: '문서 관리', exact: true })).toBeVisible();
  return { uploaded: () => uploaded, positions: () => positions };
}

test("writer uploads, verifies and downloads the original file", async ({ page }) => {
  const state = await prepare(page);
  await expect(page.getByText("아직 문서가 없습니다")).toBeVisible();
  await page.getByLabel("파일", { exact: true }).setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: body });
  await page.getByRole("button", { name: "문서 올리기", exact: true }).click();
  await expect(page.getByText("문서를 올렸습니다. 본문 처리가 시작됩니다.", { exact: true })).toBeVisible();
  expect(state.uploaded()).toBeTruthy();
  expect(state.positions()).toHaveLength(1);
  expect(state.positions()[0].document_id).toBe("document-one");
  await expect(page.getByRole("dialog").getByText("처리 대기", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "다운로드", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("notes.md");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("failed completion can be checked without uploading again", async ({ page }) => {
  const state = await prepare(page, "EDITOR", false, true);
  await page.getByLabel("파일", { exact: true }).setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: body });
  await page.getByRole("button", { name: "문서 올리기", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "서버에 연결하지 못했습니다" })).toBeVisible();
  await page.getByRole("button", { name: "업로드 확인" }).click();
  await expect(page.getByText("업로드를 확인했습니다.", { exact: true })).toBeVisible();
  expect(state.positions()).toHaveLength(1);
  await expect(page.getByRole("button", { name: "다운로드", exact: true })).toBeVisible();
});

test("viewer only sees read actions", async ({ page }) => {
  await prepare(page, "VIEWER");
  await expect(page.getByRole("button", { name: "다운로드", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "문서 올리기", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("파일", { exact: true })).toHaveCount(0);
});

test("retry requires the original file and reuses the pending version", async ({ page }) => {
  const state = await prepare(page, "OWNER", true);
  await page.getByRole("button", { name: "파일 다시 선택" }).click();
  await page.getByLabel("원본 파일 선택").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("wrong") });
  await page.getByRole("button", { name: "업로드 재시도", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "이름과 내용이 동일한 원본 파일" })).toBeVisible();
  expect(state.uploaded()).toBeFalsy();
  await page.getByLabel("원본 파일 선택").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: body });
  await page.getByRole("button", { name: "업로드 재시도", exact: true }).click();
  await expect(page.getByText("문서를 올렸습니다. 본문 처리가 시작됩니다.", { exact: true })).toBeVisible();
  expect(state.uploaded()).toBeTruthy();
  expect(state.positions()).toHaveLength(0);
});


test("dropdown and canvas file drop open a prepared upload", async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: '문서 관리 닫기' }).click();
  await page.getByRole('button', { name: '업로드 메뉴', exact: true }).click();
  await expect(page.getByRole('button', { name: '파일에서 업로드', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '업로드 메뉴', exact: true }).click();
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['A document for Phase 2\n'], 'notes.md', { type: 'text/markdown' })); return data; });
  await page.locator('.canvas-surface').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByLabel('문서 제목', { exact: true })).toHaveValue('notes');
  await page.getByRole('button', { name: '문서 올리기', exact: true }).click();
  await expect(page.getByText('문서를 올렸습니다. 본문 처리가 시작됩니다.', { exact: true })).toBeVisible();
});

test("upload icon opens native file chooser and prepares the selected file", async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: '문서 관리 닫기' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '파일 선택하여 올리기', exact: true }).click();
  await (await chooser).setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: body });
  await expect(page.getByLabel('문서 제목', { exact: true })).toHaveValue('notes');
  await expect(page.getByRole('button', { name: '문서 올리기', exact: true })).toBeEnabled();
});
