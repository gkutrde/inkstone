from __future__ import annotations
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "C:/replace-audit"
DOC = WORKSPACE + "/replace.md"
ORIGINAL = "foo foo"

def boot(browser, url, content=ORIGINAL):
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    seed = (
        "window.__PERF_FS = " + json.dumps({DOC: content}) + ";"
        "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
        "window.__PERF_DIALOG = null;"
        "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
        "localStorage.removeItem('inkstone.drafts.v1');"
        "localStorage.setItem('inkstone.settings.v1', JSON.stringify({autoSave:false,showOutline:false}));"
    )
    context.add_init_script(seed + "\n" + mock)
    page = context.new_page()
    page.on("pageerror", lambda error: print("PAGEERROR", str(error)))
    page.on("console", lambda message: print("CONSOLE", message.text) if message.type == "error" else None)
    page.on("requestfailed", lambda request: print("REQUEST_FAILED", request.url, request.failure))
    page.on("response", lambda response: print("RESPONSE_ERROR", response.status, response.url) if response.status >= 400 else None)
    page.goto(url, wait_until="networkidle")
    page.locator(".tree-row").filter(has_text="replace.md").first.click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
    page.wait_for_timeout(500)
    return context, page

def replace(page, replacement):
    page.keyboard.press("Control+f")
    page.get_by_label("查找内容").fill("foo")
    page.get_by_label("替换为").fill(replacement)
    page.get_by_role("button", name="全部替换").click()
    page.wait_for_timeout(500)

def source_text(page):
    page.locator(".mode-switch button").nth(1).click()
    try:
        page.wait_for_selector(".cm-content", timeout=20000)
    except Exception:
        print("SOURCE_STATE", page.locator("body").inner_text()[:3000])
        print("SOURCE_DEBUG", page.evaluate("() => ({active: window.__inkTest ? window.__inkTest.activeTab() : null, shell: Boolean(document.querySelector('.source-editor-shell')), cm: Boolean(document.querySelector('.cm-editor')), resources: performance.getEntriesByType('resource').map(r => r.name).filter(n => n.includes('SourceEditor')), scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean)})"))
        raise
    page.wait_for_timeout(300)
    return page.locator(".cm-content").inner_text()

def main():
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context, page = boot(browser, "http://127.0.0.1:1420")
        replace(page, "bar")
        visible = source_text(page)
        page.keyboard.press("Control+s")
        page.wait_for_timeout(600)
        saved = page.evaluate("path => window.__perfFs.files[path]", DOC)
        results["replace_reaches_source_and_disk"] = {"passed": visible.strip() == "bar bar" and saved.strip() == "bar bar", "source": visible, "saved": saved}
        context.close()

        context, page = boot(browser, "http://127.0.0.1:1420")
        replace(page, "bar")
        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.press("Control+z")
        page.wait_for_timeout(500)
        undone = page.locator(".milkdown .ProseMirror").inner_text()
        results["replace_is_undoable"] = {"passed": "foo foo" in undone and "bar" not in undone, "editor": undone}
        context.close()

        context, page = boot(browser, "http://127.0.0.1:1420", "foo")
        replace(page, "x$&y")
        literal = source_text(page)
        results["replacement_is_literal"] = {"passed": literal.strip() in ("x$&y", r"x\$\&y"), "source": literal}
        context.close()
        browser.close()
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(item["passed"] for item in results.values()) else 1

if __name__ == "__main__":
    raise SystemExit(main())