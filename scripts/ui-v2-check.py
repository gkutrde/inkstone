
from pathlib import Path
from playwright.sync_api import sync_playwright
import json

OUT = Path(r"C:\Users\25088\Documents\Harness\反编译\analysis\ui-v2")
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:1420"
MOCK = (Path(__file__).resolve().parent / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
report = {"shots": [], "console": [], "errors": []}

def shot(page, name):
    p = OUT / f"{name}.png"
    page.screenshot(path=str(p))
    report["shots"].append(name)

def typ(page, text):
    page.keyboard.type(text, delay=22)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    ctx.add_init_script(MOCK)
    page = ctx.new_page()
    page.on("console", lambda m: report["console"].append(m.type + ": " + m.text[:160]) if m.type == "error" else None)
    page.on("pageerror", lambda e: report["errors"].append(str(e)[:160]))
    page.goto(BASE, wait_until="networkidle")
    page.evaluate("() => localStorage.clear()")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    shot(page, "01-welcome")

    page.locator("button[title='偏好设置']").click()
    page.wait_for_selector(".settings-popover")
    page.wait_for_timeout(250)
    shot(page, "02-settings")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)

    page.locator(".welcome-actions .primary-button").click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=20000)
    page.wait_for_timeout(1200)
    ed = page.locator(".milkdown .ProseMirror")
    ed.click()
    typ(page, "# 夜航笔记"); page.keyboard.press("Enter"); page.wait_for_timeout(120)
    typ(page, "海面在窗外缓慢移动，像一封没有寄出的信。写作的乐趣在于，你不知道下一句会把你带到哪里，但你知道笔还在手里。")
    page.keyboard.press("Enter"); page.wait_for_timeout(120)
    page.keyboard.press("Enter"); page.wait_for_timeout(150)
    typ(page, "> 写作不是把世界解释清楚，而是让某一刻停下来。")
    page.keyboard.press("Enter"); page.wait_for_timeout(150)
    page.keyboard.press("Enter"); page.wait_for_timeout(150)
    typ(page, "## 今晚的记录"); page.keyboard.press("Enter"); page.wait_for_timeout(150)
    typ(page, "- 风从北边来"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    typ(page, "灯还亮着"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    typ(page, "明天继续"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    typ(page, "把没说的话写完"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    page.keyboard.press("Enter"); page.wait_for_timeout(200)
    typ(page, "### 一句闲话"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    typ(page, "好的工具不催你，也不打断你；它只是把纸铺平，把光调柔。")
    page.wait_for_timeout(1300)
    shot(page, "03-editor")
    if page.locator(".outline-panel").count() == 0:
        page.locator("button[title='切换大纲']").click(); page.wait_for_timeout(400)
    shot(page, "04-editor-outline")

    page.keyboard.press("Control+k")
    page.wait_for_selector(".command-dialog"); page.wait_for_timeout(300)
    shot(page, "05-command")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    page.locator("button[title^='切换主题']").click(); page.wait_for_timeout(500)
    shot(page, "06-sepia")
    page.locator("button[title^='切换主题']").click(); page.wait_for_timeout(500)
    shot(page, "07-night")
    page.locator("button[title^='切换主题']").click(); page.wait_for_timeout(400)

    page.locator(".mode-switch button").nth(1).click()
    page.wait_for_selector(".cm-editor", timeout=20000); page.wait_for_timeout(900)
    shot(page, "08-source")
    page.locator(".mode-switch button").nth(0).click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=20000); page.wait_for_timeout(900)

    page.keyboard.press("Control+f"); page.wait_for_timeout(350)
    shot(page, "09-find"); page.keyboard.press("Escape")

    page.keyboard.press("Control+Shift+d"); page.wait_for_timeout(600)
    shot(page, "10-focus")
    page.keyboard.press("Control+Shift+d"); page.wait_for_timeout(400)

    m = browser.new_context(viewport={"width": 420, "height": 860}, device_scale_factor=2)
    m.add_init_script(MOCK)
    mp = m.new_page(); mp.goto(BASE, wait_until="networkidle"); mp.wait_for_timeout(900)
    shot(mp, "11-mobile-welcome")
    m.close()

    browser.close()

print(json.dumps(report, ensure_ascii=False, indent=1))
