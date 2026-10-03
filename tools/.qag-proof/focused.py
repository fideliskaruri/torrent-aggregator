import json
import pathlib
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(__file__).parent
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    for width in [390, 1280]:
        context = browser.new_context(viewport={"width":width,"height":900},service_workers="block")
        page = context.new_page()
        page.set_default_timeout(10000)
        errors,network = [],[]
        page.on("console",lambda m: errors.append(m.text) if m.type=="error" else None)
        page.on("pageerror",lambda e: errors.append(str(e)))
        page.on("requestfailed",lambda r: network.append({"url":r.url,"error":r.failure}))
        page.on("response",lambda r: network.append({"url":r.url,"status":r.status}) if r.status>=400 else None)
        def capture(name):
            page.wait_for_timeout(700)
            text=page.locator("body").inner_text()
            file=f"screenshots/{name}-{width}.png"
            page.screenshot(path=str(OUT/file),full_page=True)
            results.append({"name":name,"width":width,"url":page.url,"text":text,"consoleErrors":list(errors),"failedNetwork":list(network),"screenshot":file,"overflow":page.evaluate("({inner:innerWidth,scroll:document.documentElement.scrollWidth})")})
            (OUT/"focused.json").write_text(json.dumps(results,indent=2),encoding="utf-8")
            print(name,width,flush=True)
        page.goto("http://127.0.0.1:3961/settings",wait_until="networkidle")
        for name in ["Advanced","Sources","Jellyfin","Remote access","App"]:
            button=page.get_by_role("button",name=name,exact=False).first
            button.click()
            capture("settings-"+name.lower().replace(" ","-"))
            button.click()
        page.goto("http://127.0.0.1:3961/search?q=Rick%20and%20Morty",wait_until="networkidle")
        links=page.locator('a[href*="/title/"]').evaluate_all("(es)=>es.map(e=>({text:e.textContent,href:e.getAttribute('href')}))")
        (OUT/f"search-title-links-{width}.json").write_text(json.dumps(links,indent=2))
        page.goto("http://127.0.0.1:3961/title/rick-and-morty-2013",wait_until="networkidle")
        capture("owned-legacy-series")
        page.goto("http://127.0.0.1:3961/title/tmdb:tv:60625",wait_until="networkidle")
        capture("owned-canonical-series")
        select=page.locator("select").first
        if select.count():
            select.select_option("2")
            page.wait_for_timeout(4000)
            capture("series-season-two")
        page.goto("http://127.0.0.1:3961/",wait_until="networkidle")
        preview=page.get_by_role("button",name="View as requester",exact=True)
        if not preview.count():
            page.get_by_role("button",name="More",exact=True).click()
            preview=page.get_by_role("button",name="View as requester",exact=True)
        preview.first.click()
        capture("requester-home")
        for name,route in [("search","/search?q=Rick%20and%20Morty"),("film","/title/tmdb:movie:45745"),("series","/title/tmdb:tv:60625"),("anime","/title/anilist:21"),("library","/watchlist"),("calendar","/upcoming"),("requests","/requests"),("alerts","/notifications"),("settings-hidden","/settings"),("downloads-hidden","/downloads")]:
            errors.clear();network.clear()
            page.goto("http://127.0.0.1:3961"+route,wait_until="networkidle",timeout=45000)
            capture("requester-"+name)
        context.close()
    browser.close()
