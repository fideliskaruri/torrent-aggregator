import json
import pathlib
import time
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(__file__).parent
(OUT / "screenshots").mkdir(exist_ok=True)
rows = []
routes = [
    ("home", "/"), ("films", "/?type=films"), ("series", "/?type=series"),
    ("anime", "/?type=anime"), ("films-comedy", "/?type=films&genre=comedy"),
    ("series-drama", "/?type=series&genre=drama"), ("anime-action", "/?type=anime&genre=action"),
    ("search-results", "/search?q=Rick%20and%20Morty"), ("search-none", "/search?q=zzzxqvnotatitle938475"),
    ("film", "/title/tmdb:movie:45745"), ("series-title", "/title/tmdb:tv:60625"),
    ("anime-title", "/title/anilist:21"), ("library", "/watchlist"), ("downloads", "/downloads"),
    ("upcoming", "/upcoming"), ("requests", "/requests"), ("notifications", "/notifications"),
    ("everything", "/everything"), ("history", "/history"), ("rules", "/rules"),
    ("settings", "/settings"), ("settings-library", "/settings/library"), ("about", "/about"), ("share", "/share"),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    for port, label in [(3961, "copied"), (3962, "empty")]:
        for width in [390, 1280]:
            context = browser.new_context(viewport={"width": width, "height": 900}, service_workers="block")
            page = context.new_page()
            page.set_default_timeout(8000)
            errors, failed = [], []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("requestfailed", lambda r: failed.append({"url": r.url, "error": r.failure}))
            page.on("response", lambda r: failed.append({"url": r.url, "status": r.status}) if r.status >= 400 else None)
            for name, route in routes:
                errors.clear()
                failed.clear()
                start = time.monotonic()
                row = {"run": label, "port": port, "width": width, "page": name, "route": route}
                try:
                    page.goto(f"http://127.0.0.1:{port}{route}", wait_until="domcontentloaded", timeout=20000)
                    try:
                        page.wait_for_load_state("networkidle", timeout=18000)
                    except Exception:
                        row["networkIdleTimeout"] = True
                    page.wait_for_timeout(700)
                    text = page.locator("body").inner_text()
                    row["text"] = text
                    row["overflow"] = page.evaluate("({inner:innerWidth,scroll:document.documentElement.scrollWidth,bad:[...document.querySelectorAll('main *')].filter(e=>{let r=e.getBoundingClientRect();let s=getComputedStyle(e);return r.width>0&&(r.right>innerWidth+2||r.left< -2)&&s.position!=='absolute'}).slice(0,12).map(e=>({tag:e.tagName,text:e.textContent?.slice(0,90),right:e.getBoundingClientRect().right}))})")
                    row["copyFlags"] = [line for line in text.splitlines() if "—" in line or any(t in line.lower() for t in ["acquisition", "pipeline", "workkey", "reconciliation"])]
                    row["screenshot"] = f"screenshots/{label}-{name}-{width}.png"
                    page.screenshot(path=str(OUT / row["screenshot"]), full_page=True)
                    if name == "settings":
                        row["controls"] = page.locator("button").all_text_contents()
                        for i, section in enumerate(page.locator("main section").all()):
                            if section.is_visible():
                                section.screenshot(path=str(OUT / "screenshots" / f"{label}-settings-section-{i}-{width}.png"))
                        for advanced in page.get_by_role("button", name="Advanced", exact=False).all():
                            if advanced.is_visible():
                                advanced.click()
                                page.wait_for_timeout(500)
                                page.screenshot(path=str(OUT / "screenshots" / f"{label}-settings-advanced-{width}.png"), full_page=True)
                                break
                    if name == "series-title":
                        row["seasonControls"] = page.locator("button").all_text_contents()
                        select = page.locator('select').first
                        if select.count():
                            options = select.locator("option").all()
                            if len(options) > 1:
                                select.select_option(options[1].get_attribute("value"))
                                page.wait_for_timeout(2000)
                                page.screenshot(path=str(OUT / "screenshots" / f"{label}-series-season2-{width}.png"), full_page=True)
                    row["result"] = "checked"
                except Exception as e:
                    row["result"] = "blocked"
                    row["error"] = str(e)
                row["consoleErrors"], row["failedNetwork"] = list(errors), list(failed)
                row["seconds"] = round(time.monotonic() - start, 2)
                rows.append(row)
                (OUT / "walk.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
                print(label, width, name, row["result"], len(errors), len(failed), flush=True)
            context.close()
    browser.close()
