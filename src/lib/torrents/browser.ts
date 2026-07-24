/**
 * Optional Playwright fetch for sites that block plain `fetch`.
 * Returns null if Playwright is unavailable or the page stays on a bot wall.
 */
export async function fetchWithBrowser(
  url: string,
  options?: { timeoutMs?: number; waitForSelector?: string },
): Promise<{ status: number; html: string; finalUrl: string } | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1365, height: 900 },
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      const page = await context.newPage();
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options?.timeoutMs ?? 35_000,
      });

      // Wait out lightweight challenges when possible
      try {
        await page.waitForFunction(
          () => !document.title.toLowerCase().includes("just a moment"),
          { timeout: 12_000 },
        );
      } catch {
        // challenge still present
      }

      if (options?.waitForSelector) {
        try {
          await page.waitForSelector(options.waitForSelector, {
            timeout: 8_000,
          });
        } catch {
          // ignore
        }
      }

      const title = await page.title();
      const html = await page.content();
      const status = resp?.status() ?? 0;
      const finalUrl = page.url();

      await context.close();

      if (
        title.toLowerCase().includes("just a moment") ||
        html.includes("cf-challenge") ||
        html.includes("Performing security verification")
      ) {
        return { status: status || 403, html, finalUrl };
      }

      return { status: status || 200, html, finalUrl };
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn("[browser-fetch]", err);
    return null;
  }
}
