import { expect, test } from "@playwright/test";

test("login presents configuration state without a broken login action", async ({ page }, info) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "ConText" })).toBeVisible();
  const logo = page.getByRole("heading", { name: "ConText" }).locator("img");
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  for (const selector of ['link[rel="icon"][href*="favicon"]', 'link[rel="icon"][href*="icon.png"]', 'link[rel="apple-touch-icon"]']) {
    const href = await page.locator(selector).getAttribute("href");
    expect(href).toBeTruthy();
    const response = await page.request.get(href!);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toMatch(/image\//);
  }
  await expect(page.getByRole("button", { name: "Google로 계속하기" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("로그인 서비스가 아직 준비되지 않았습니다");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: `/tmp/context-logo-login-${info.project.name}.png` });
});

test("anonymous workspace routes redirect to login", async ({ page }) => {
  for (const path of ["/workspaces", "/workspaces/00000000-0000-0000-0000-000000000001"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "나의 워크스페이스" })).toHaveCount(0);
  }
});

test("public landing offers web access and honest desktop download availability", async ({ page }, info) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("내 문서와 AI가");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("함께 일하는 공간.");
  await expect(page).toHaveTitle("ConText · 내 PC에서 시작하는 AI 문서 작업 공간");
  await expect(page.getByRole("link", { name: "웹에서 시작하기" }).first()).toHaveAttribute("href", "/workspaces");
  await expect(page.getByRole("link", { name: "데스크톱 다운로드", exact: true })).toHaveAttribute("href", "#start");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `/tmp/context-landing-${info.project.name}.png` });
  const preview = page.getByRole("figure", { name: "AI 문서 작업 흐름 예시" });
  await expect(preview).toContainText("실제 파일을 읽거나 수정하지 않아요");
  await preview.getByRole("button", { name: "적용 결과 예시" }).click();
  await expect(preview.getByRole("status")).toContainText("예시 화면만 변경됐어요");
  await preview.getByRole("button", { name: "문장 다듬기" }).click();
  await expect(preview.getByRole("button", { name: "문장 다듬기" })).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toContainText("프로젝트 소개.txt");
  await expect(preview.getByRole("button", { name: "적용 결과 예시" })).toBeVisible();
  await preview.getByRole("button", { name: "회의록 정리" }).click();

  await page.getByRole("link", { name: "데스크톱 다운로드", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 컴퓨터에서 시작하세요." })).toBeInViewport();
  await expect(page.getByRole("button", { name: "macOS 다운로드 배포 준비 중" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Windows 다운로드 배포 준비 중" })).toBeDisabled();
  await expect(page.getByText("클라우드 동기화는 필요할 때 선택하세요.", { exact: false })).toBeVisible();
  if (info.project.name === "desktop") await page.screenshot({ path: "/tmp/context-landing-downloads-desktop.png" });
  await page.locator("summary").filter({ hasText: "기존 파일에 바로 적용할 수 있나요" }).click();
  await expect(page.getByText("채팅에서 원본 파일에 바로 적용하는 흐름은 준비 중", { exact: false })).toBeVisible();
  await page.locator("summary").filter({ hasText: "AI도 오프라인으로 실행되나요" }).click();
  await expect(page.getByText("현재 AI 답변은 인터넷과 별도 AI 연결이 필요", { exact: false })).toBeVisible();
});

test("web entry from landing follows the existing authentication flow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "웹에서 시작하기" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "ConText" })).toBeVisible();
});

test("failed callback safely returns to login", async ({ page }) => {
  await page.goto("/auth/callback?error=access_denied&next=https://attacker.example");
  await expect(page).toHaveURL(/\/login\?error=callback$/);
  await expect(page.getByRole("alert").filter({ hasText: "로그인을 완료하지 못했습니다" })).toContainText("로그인을 완료하지 못했습니다");
});
