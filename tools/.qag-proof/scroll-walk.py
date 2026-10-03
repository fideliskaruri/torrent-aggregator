import json
import pathlib
from playwright.sync_api import sync_playwright

OUT=pathlib.Path(__file__).parent
rows=[]
routes=[("home","/"),("films","/?type=films"),("series","/?type=series"),("anime","/?type=anime"),("film","/title/tmdb:movie:45745"),("series-title","/title/tmdb:tv:60625"),("anime-title","/title/anilist:21"),("library","/watchlist"),("downloads","/downloads"),("upcoming","/upcoming"),("notifications","/notifications"),("settings","/settings")]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel="msedge")
    for width in [390,1280]:
        context=browser.new_context(viewport={"width":width,"height":900},service_workers="block")
        page=context.new_page()
        errors=[]
        page.on("console",lambda m:errors.append(m.text) if m.type=="error" else None)
        page.on("response",lambda r:errors.append(f"HTTP {r.status}: {r.url}") if r.status>=400 else None)
        for name,route in routes:
            errors.clear()
            page.goto("http://127.0.0.1:3961"+route,wait_until="networkidle",timeout=45000)
            height=page.evaluate("document.documentElement.scrollHeight")
            for y in range(0,height,720):
                page.evaluate("(y)=>window.scrollTo(0,y)",y)
                page.wait_for_timeout(120)
            page.wait_for_timeout(700)
            page.evaluate("window.scrollTo(0,0)")
            page.screenshot(path=str(OUT/"screenshots"/f"copied-{name}-{width}.png"),full_page=True)
            rows.append({"page":name,"width":width,"scrollHeight":height,"failedResources":list(errors),"images":page.locator("img").evaluate_all("(es)=>es.map(e=>({src:e.currentSrc,loaded:e.complete&&e.naturalWidth>0,alt:e.alt}))")})
            (OUT/"scroll-walk.json").write_text(json.dumps(rows,indent=2))
            print(width,name,"scroll",height,"errors",len(errors),flush=True)
        context.close()
    browser.close()
