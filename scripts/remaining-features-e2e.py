from __future__ import annotations
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "C:/remaining-features"
REF_DOC = WORKSPACE + "/references.md"
RESIZE_DOC = WORKSPACE + "/resize.md"
REFERENCE_TEXT = """[甲][ref] 与 [乙][ref]，还有 [折叠引用][] 和 [快捷引用]。

![引用式图片][pixel-reference]

[ref]: https://example.com "引用标题"
[折叠引用]: https://example.com/folded
[快捷引用]: https://example.com/shortcut
[pixel-reference]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=
"""
SVG = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#a63d28"/></svg>').decode()
RESIZE_TEXT = "![照片 alt](data:image/svg+xml;base64," + SVG + " '照片标题')"
results = {}
page_errors = []

def check(name, passed, actual=None):
    results[name] = {"passed": bool(passed), "actual": actual}

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1360, "height": 900})
        mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
        seed = (
            "window.__PERF_FS = " + json.dumps({REF_DOC: REFERENCE_TEXT, RESIZE_DOC: RESIZE_TEXT}) + ";"
            "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
            "window.__PERF_DIALOG = null;"
            "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
            "localStorage.removeItem('inkstone.drafts.v1');"
            "localStorage.setItem('inkstone.settings.v1', JSON.stringify({autoSave:false,showOutline:false,showSidebar:true}));"
        )
        context.add_init_script(seed + "\n" + mock)
        page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        page.goto("http://127.0.0.1:1420", wait_until="networkidle")
        page.locator(".tree-row").filter(has_text="references.md").first.click()
        try:
            page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        except Exception:
            print("INIT_ERROR", page.locator("body").inner_text()[:4000], page_errors)
            raise
        page.wait_for_timeout(700)
        refs = page.locator(".milkdown a[data-reference]")
        definitions = page.locator(".reference-definition")
        check("reference_links_render_with_definitions", refs.count() >= 3 and definitions.count() == 4, {"links": refs.count(), "definitions": definitions.count()})
        check("reference_image_renders", page.locator('img[data-type="image-block"]').first.evaluate("img => img.complete && img.naturalWidth === 1"), page.locator('img[data-type="image-block"]').first.get_attribute("alt"))
        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".cm-content")
        page.wait_for_timeout(350)
        source = page.evaluate("() => window.__inkTest.activeTab().content")
        expected = ["[甲][ref]", "[乙][ref]", "[折叠引用][]", "[快捷引用]", "![引用式图片][pixel-reference]", "[ref]: https://example.com", "[pixel-reference]: data:image/png;base64,"]
        check("reference_forms_survive_roundtrip", all(token in source for token in expected) and "[甲](https://example.com)" not in source, source)

        page.locator(".mode-switch button").nth(0).click()
        page.wait_for_selector(".milkdown .ProseMirror")
        page.locator(".tree-row").filter(has_text="resize.md").first.click()
        page.wait_for_selector('img[data-type="image-block"]', timeout=30000)
        image = page.locator('img[data-type="image-block"]').first
        page.wait_for_function("img => img.complete && img.naturalHeight === 200", arg=image.element_handle())
        image.click()
        handle = page.locator(".image-resize-handle").first
        box = image.bounding_box()
        handle_box = handle.bounding_box()
        check("resize_handle_is_available", bool(box and handle_box), {"image": box, "handle": handle_box})
        page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + handle_box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] + 20, box["y"] + 100, steps=8)
        page.mouse.up()
        page.wait_for_timeout(400)
        check("image_resize_updates_ratio", image.evaluate("img => img.style.height") == "100px", image.evaluate("img => img.style.height"))
        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".cm-content")
        page.wait_for_timeout(350)
        resized_source = page.evaluate("() => window.__inkTest.activeTab().content")
        check("resized_image_serializes_html_with_alt", 'data-ratio="0.5"' in resized_source and 'style="width:50%"' in resized_source and 'alt="照片 alt"' in resized_source and 'title="照片标题"' in resized_source, resized_source)
        page.keyboard.press("Control+s")
        page.wait_for_timeout(600)
        saved = page.evaluate("path => window.__perfFs.files[path]", RESIZE_DOC)
        check("resized_image_is_saved", 'data-ratio="0.5"' in saved and 'alt="照片 alt"' in saved, saved)
        page.locator(".tab-item.is-active .tab-close").click()
        page.locator(".tree-row").filter(has_text="resize.md").first.click()
        page.wait_for_selector('img[data-type="image-block"]', timeout=30000)
        page.wait_for_timeout(600)
        restored = page.locator('img[data-type="image-block"]').first
        check("resized_ratio_survives_reopen", restored.get_attribute("alt") == "照片 alt" and restored.evaluate("img => img.style.height") == "100px", {"ratio": restored.get_attribute("data-ratio"), "alt": restored.get_attribute("alt"), "height": restored.evaluate("img => img.style.height")})
        check("no_uncaught_page_errors", not page_errors, page_errors)
        browser.close()
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(item["passed"] for item in results.values()) else 1

if __name__ == "__main__":
    raise SystemExit(main())
