import { expect, test } from "@playwright/test";

const TITLE_URL =
  "/title/rick-and-morty?t=Rick+and+Morty&type=tv";

test("title page responsive layout", async ({ page }) => {
  await page.goto(TITLE_URL);
  await page.locator("[data-title-hero]").waitFor();
  await page.locator("[data-episode-row]").first().waitFor();
  await page.locator("[data-season-select]").selectOption("2");
  await expect(page.locator("[data-season-select]")).toHaveValue("2");
  await expect(page.locator("[data-episode-name]").first()).toContainText(
    "S02E01",
  );
  await page.evaluate(() => document.fonts.ready);
  await page.locator("img:visible").evaluateAll(async (elements) => {
    const images = elements.filter(
      (element): element is HTMLImageElement =>
        element instanceof HTMLImageElement,
    );
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) return;
        await Promise.race([
          image.decode().catch(() => undefined),
          new Promise<void>((resolve) => window.setTimeout(resolve, 3_000)),
        ]);
      }),
    );
  });
  await page.addStyleTag({
    content:
      'button[aria-label="Open Next.js Dev Tools"] { display: none !important; }',
  });

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);

  await expect(page).toHaveScreenshot("rick-and-morty-title.png", {
    fullPage: true,
    mask: [
      page.locator("[data-title-primary]"),
      page.locator('[data-episode-action][data-action="download"]'),
      page.locator("[data-episode-progress]"),
      page.locator("[data-watched-label]"),
    ],
  });
});
