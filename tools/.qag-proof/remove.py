import json
import pathlib
import time
import urllib.request
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(__file__).parent
ROOT = pathlib.Path(r"D:\code\memtest\qag-library-final")
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width":390,"height":900})
    page.goto("http://127.0.0.1:3962/downloads",wait_until="networkidle")
    page.locator("[data-torrent-more]").first.click()
    page.screenshot(path=str(OUT/"screenshots/completed-menu-390.png"),full_page=True)
    (OUT/"completed-menu.json").write_text(json.dumps({"text":page.locator("body").inner_text()},indent=2))
    page.locator("[data-delete-torrent]").click()
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT/"screenshots/remove-confirm-390.png"),full_page=True)
    dialog=page.get_by_role("alertdialog")
    text=dialog.inner_text()
    (OUT/"remove-dialog.json").write_text(json.dumps({"text":text,"buttons":dialog.locator("button").all_text_contents()},indent=2))
    print(text,flush=True)
    for box in dialog.get_by_role("checkbox").all():
        if not box.is_checked():
            box.check()
    candidates=dialog.get_by_role("button",name="Delete",exact=False)
    candidates.last.click()
    page.wait_for_timeout(3000)
    page.screenshot(path=str(OUT/"screenshots/removed-download-390.png"),full_page=True)
    files=[str(x.relative_to(ROOT)) for x in ROOT.rglob("*") if x.is_file()]
    data=json.load(urllib.request.urlopen("http://127.0.0.1:3962/api/client/torrents"))
    (OUT/"removal-ui-result.json").write_text(json.dumps({"remainingFiles":files,"http":data,"text":page.locator("body").inner_text()},indent=2))
    print("remaining files",files,flush=True)
    browser.close()
