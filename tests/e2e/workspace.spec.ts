import { test, expect } from "@playwright/test";
test("catalog, search, project README, source and comparison", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Каталог проектов/ }),
  ).toBeVisible();
  await page.getByLabel("Поиск проектов").fill("Digital_yakuza");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Сравнить Digital_yakuza" }).check();
  await page
    .getByRole("link", { name: /Digital_yakuza/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Digital_yakuza", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "README", exact: true }).click();
  await expect(page.locator(".markdown h1")).toContainText("Digital Yakuza");
  await page.getByRole("button", { name: "Исходники", exact: true }).click();
  await page
    .getByRole("link", { name: "beeline_agent/agent.py", exact: true })
    .click();
  await expect(page.locator(".source-viewer pre")).toContainText("class Agent");
  await page.getByRole("link", { name: "Каталог", exact: true }).click();
  await page.getByLabel("Поиск проектов").fill("IFlow");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Сравнить IFlow" }).check();
  await page
    .getByRole("button", { name: "Сравнить проекты", exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "Digital_yakuza", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "IFlow", exact: true }),
  ).toBeVisible();
});
test("methodology, settings and mobile remain usable", async ({ page }) => {
  await page.goto("/methodology");
  await expect(
    page.getByRole("heading", { name: "Методика и источники" }),
  ).toBeVisible();
  await expect(page.locator(".source-list details")).toHaveCount(12);
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Обработка и настройки" }),
  ).toBeVisible();
  await expect(page.getByText("OpenAI Codex", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Поиск проектов")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
