import json
from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path(__file__).parent
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    for width in [390, 768, 1280]:
        context = browser.new_context(viewport={"width": width, "height": 1100}, service_workers="block")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto("http://127.0.0.1:3963/downloads", wait_until="networkidle")
        page.get_by_role("button", name="Open Sintel").wait_for()
        page.wait_for_timeout(500)
        page.screenshot(path=str(out / f"downloads-{width}.png"), full_page=True)
        with page.expect_response(lambda r: "/open" in r.url and r.request.method == "POST") as response:
            page.get_by_role("button", name="Open Sintel").click()
        opened = response.value.json()
        assert response.value.status == 200 and opened["ok"] and opened["launched"] is False
        page.get_by_role("button", name="More actions for Sintel").click()
        page.get_by_role("menuitem", name="Show in folder").wait_for()
        page.screenshot(path=str(out / f"downloads-menu-{width}.png"), full_page=True)
        with page.expect_response(lambda r: "/open" in r.url and r.request.method == "POST") as response:
            page.get_by_role("menuitem", name="Show in folder").click()
        revealed = response.value.json()
        assert response.value.status == 200 and revealed["ok"] and revealed["mode"] == "reveal"
        assert revealed["launched"] is False and revealed["path"] == opened["path"]
        layout = page.evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth})")
        print(layout, flush=True)
        assert layout["width"] == width and layout["scroll"] <= width
        assert not errors, errors
        results.append({"width": width, "open": opened, "reveal": revealed, "layout": layout, "consoleErrors": errors})
        (out / "browser.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        context.close()
    browser.close()
print("Real Open and Show in folder controls pass at 390, 768, 1280; no launch or horizontal overflow.")
