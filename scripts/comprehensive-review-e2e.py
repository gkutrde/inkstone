from __future__ import annotations
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "analysis" / "comprehensive-review"
OUT.mkdir(parents=True, exist_ok=True)
WORKSPACE = "C:/review-workspace"
FRONTMATTER = "---\r\ntitle: 夜航\r\ntags: [写作, 本地]\r\n---\r\n\r\n# 正文\r\n"
FILES = {
    WORKSPACE + "/frontmatter.md": FRONTMATTER,
    WORKSPACE + "/image.md": "![2024](sub/img.png)",
    WORKSPACE + "/find.md": "# 苹果\n\n正文*里的*苹果。",
    WORKSPACE + "/苹果.md": "侧栏同名文件",
    WORKSPACE + "/sub/img.png": "not-a-real-png",
}
results = {}
page_errors = []

def check(name, passed, actual=None):
    results[name] = {"passed": bool(passed), "actual": actual}

def seed_context(browser, settings=None):
    context = browser.new_context(viewport={"width": 1100, "height": 820})
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    prefs = {"autoSave": False, "showOutline": True, "showSidebar": True, "theme": "paper"}
    prefs.update(settings or {})
    seed = (
        "window.__PERF_FS = " + json.dumps(FILES) + ";"
        "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
        "window.__PERF_DIALOG = null;"
        "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
        "localStorage.removeItem('inkstone.drafts.v1');"
        "localStorage.setItem('inkstone.settings.v1', " + json.dumps(json.dumps(prefs)) + ");"
    )
    context.add_init_script(seed + "\n" + mock)
    return context

def open_doc(page, name):
    row = page.locator(".tree-row").filter(has_text=name).first
    row.click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
    page.wait_for_timeout(500)

def source_content(page):
    return page.evaluate("() => window.__inkTest.activeTab().content")

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = seed_context(browser)
        page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:1420", wait_until="networkidle")

        unit = page.evaluate(r"""async () => {
          const metrics = await import('/src/lib/metrics.ts');
          const paths = await import('/src/lib/path.ts');
          const front = await import('/src/lib/frontmatter.ts');
          const scheduler = await import('/src/lib/editorScheduler.ts');
          const exporter = await import('/src/lib/export-html.ts');
          const outline = metrics.extractOutline('````\n```\n# phantom\n````\n\n# C#\n\nSetext\n---');
          const tilde = metrics.countText('~~~\nconst a = 1;\n~~~\n\n正文');
          const ticks = metrics.countText('```\nconst a = 1;\n```\n\n正文');
          const html = exporter.markdownToHtml('[ok](https://example.com) [bad](javascript:alert(1)) <script>alert(2)<\/script><img src=x onerror=alert(3)>');
          const standalone = exporter.standaloneHtml('安全', '<script>alert(1)<\/script>', null, 'paper');
          const parts = front.splitFrontmatter('---\r\ntitle: T\r\n---\r\n\r\n# Body');
          return {
            outline,
            wordsEqual: tilde.words === ticks.words && tilde.words === 2,
            emptyMinutes: metrics.countText('').minutes,
            resolved: paths.documentAssetPath('C:/w/sub/note.md', 'C:/w', 'img.png'),
            inserted: paths.markdownAssetPath('C:/w/sub/note.md', 'C:/w', 'assets/a.png'),
            percent: paths.documentAssetPath('C:/w/sub/note.md', 'C:/w', '100%.png'),
            frontRoundtrip: front.restoreFrontmatter(parts.prefix, parts.body),
            chineseBytes: scheduler.estimateDocumentBytes(60000, '汉'.repeat(4000)),
            chineseTier: scheduler.delayForDocSize(scheduler.estimateDocumentBytes(60000, '汉'.repeat(4000))),
            html,
            hasCsp: standalone.includes('Content-Security-Policy') && standalone.includes("script-src &apos;none&apos;")
          };
        }""")
        texts = [item["text"] for item in unit["outline"]]
        check("outline_fences_and_heading_text", texts == ["C#", "Setext"], texts)
        check("equivalent_fences_have_equal_counts", unit["wordsEqual"], unit)
        check("empty_document_has_zero_reading_minutes", unit["emptyMinutes"] == 0, unit["emptyMinutes"])
        check("document_relative_image_resolution", unit["resolved"] == "C:/w/sub/img.png" and unit["percent"] == "C:/w/sub/100%.png", unit)
        check("uploaded_image_is_relative_to_document", unit["inserted"] == "../assets/a.png", unit["inserted"])
        check("frontmatter_helper_preserves_crlf", unit["frontRoundtrip"] == "---\r\ntitle: T\r\n---\r\n\r\n# Body", unit["frontRoundtrip"])
        check("cjk_scheduler_estimates_utf8_cost", unit["chineseBytes"] == 180000 and unit["chineseTier"] == 350, unit)
        check("html_export_sanitizes_active_content", "javascript:" not in unit["html"] and "<script" not in unit["html"] and "onerror" not in unit["html"] and 'href="https://example.com"' in unit["html"], unit["html"])
        check("standalone_html_has_script_csp", unit["hasCsp"], unit["hasCsp"])

        open_doc(page, "frontmatter.md")
        note = page.locator(".frontmatter-note")
        check("frontmatter_notice_is_visible", note.count() == 1 and "YAML" in note.inner_text(), note.inner_text() if note.count() else None)
        check("frontmatter_excluded_from_outline", page.locator(".outline-item").all_inner_texts() == ["正文"], page.locator(".outline-item").all_inner_texts())
        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".cm-content")
        page.wait_for_timeout(300)
        preserved = source_content(page)
        prefix = FRONTMATTER[:FRONTMATTER.index("# 正文")]
        check("frontmatter_survives_rich_to_source", preserved.startswith(prefix) and "# 正文" in preserved, preserved)
        page.keyboard.press("Control+s")
        page.wait_for_timeout(500)
        saved = page.evaluate("path => window.__perfFs.files[path]", WORKSPACE + "/frontmatter.md")
        check("frontmatter_save_is_byte_stable", saved.startswith(prefix), saved)
        page.screenshot(path=str(OUT / "frontmatter-source.png"))

        page.locator(".mode-switch button").nth(0).click()
        page.wait_for_selector(".milkdown .ProseMirror")
        open_doc(page, "image.md")
        image = page.locator('img[data-type="image-block"]').first
        check("numeric_alt_and_relative_src", image.get_attribute("alt") == "2024" and image.get_attribute("src").endswith("/sub/img.png"), {"alt": image.get_attribute("alt"), "src": image.get_attribute("src")})
        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".cm-content")
        image_source = source_content(page)
        check("numeric_alt_not_rewritten_as_ratio", "2024.00" not in image_source and "![2024]" in image_source, image_source)

        page.locator(".mode-switch button").nth(0).click()
        page.wait_for_selector(".milkdown .ProseMirror")
        open_doc(page, "find.md")
        page.keyboard.press("Control+k")
        page.wait_for_selector(".command-dialog")
        command_focus = page.evaluate("() => Boolean(document.activeElement?.closest('.command-dialog'))")
        check("command_palette_keeps_focus_in_midwidth_drawer", command_focus, page.evaluate("() => document.activeElement?.outerHTML"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        check("closing_palette_does_not_steal_editor_focus", not page.evaluate("() => Boolean(document.activeElement?.closest('.outline-heading'))"), page.evaluate("() => document.activeElement?.outerHTML"))

        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.press("Control+f")
        page.get_by_label("查找内容").fill("苹果")
        page.wait_for_timeout(250)
        check("rich_find_count_excludes_workspace_chrome", page.locator(".find-count").inner_text() == "2 处", page.locator(".find-count").inner_text())
        page.get_by_label("查找内容").fill("正文里的")
        page.wait_for_timeout(200)
        check("rich_find_matches_across_inline_marks", page.locator(".find-count").inner_text() == "1 处", page.locator(".find-count").inner_text())
        page.get_by_role("button", name="下一处 (Enter)").click()
        in_editor = page.evaluate("() => Boolean(document.activeElement?.closest('.ProseMirror'))")
        check("rich_find_selection_stays_in_editor", in_editor, page.evaluate("() => document.activeElement?.outerHTML"))
        page.keyboard.press("Control+f")
        repeated_focus = page.evaluate("() => document.activeElement?.getAttribute('aria-label') === '查找内容'")
        check("repeated_ctrl_f_refocuses_find_input", repeated_focus, page.evaluate("() => document.activeElement?.outerHTML"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        returned = page.evaluate("() => Boolean(document.activeElement?.classList.contains('ProseMirror'))")
        check("escape_returns_focus_to_editor", returned, page.evaluate("() => document.activeElement?.outerHTML"))

        geometry = page.evaluate("""() => {
          const editorElement = document.querySelector('.editor-viewport');
          const outlineElement = document.querySelector('.outline-panel');
          if (!editorElement || !outlineElement) return null;
          const editor = editorElement.getBoundingClientRect();
          const outline = outlineElement.getBoundingClientRect();
          return {editorRight: editor.right, outlineLeft: outline.left, width: innerWidth};
        }""")
        check("midwidth_outline_does_not_cover_editor", geometry is not None and geometry["editorRight"] <= geometry["outlineLeft"] + 1, geometry)
        page.screenshot(path=str(OUT / "midwidth-editor.png"))

        conflict_path = WORKSPACE + "/find.md"
        page.evaluate(r"""path => {
          const content = '# 外部版本\n\n磁盘上的新内容。';
          window.__perfFs.files[path] = content;
          window.__perfFs.meta[path].modifiedMs += 1000;
          window.__perfFs.meta[path].size = new TextEncoder().encode(content).length;
        }""", conflict_path)
        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.press("Control+End")
        page.keyboard.type(" 本地未保存")
        page.wait_for_timeout(400)
        page.keyboard.press("Control+s")
        page.wait_for_selector(".conflict-banner", timeout=10000)
        check("save_conflict_offers_recovery_actions", page.get_by_role("button", name="重新加载").count() == 1 and page.get_by_role("button", name="另存为").count() >= 1, page.locator(".conflict-banner").inner_text())
        page.screenshot(path=str(OUT / "save-conflict.png"))
        page.get_by_role("button", name="重新加载").click()
        page.wait_for_timeout(900)
        reloaded = source_content(page)
        check("reload_recovers_from_disk_conflict", "外部版本" in reloaded and "本地未保存" not in reloaded and page.locator(".conflict-banner").count() == 0, reloaded)
        context.close()

        night_context = seed_context(browser, {"theme": "night"})
        night_context.add_init_script("document.addEventListener('DOMContentLoaded', () => { window.__themeAtDcl = document.documentElement.dataset.theme; });")
        night = night_context.new_page()
        night.goto("http://127.0.0.1:1420", wait_until="networkidle")
        check("stored_theme_applies_before_first_screen", night.evaluate("() => document.documentElement.dataset.theme === 'night' && window.__themeAtDcl === 'night'"), night.evaluate("() => ({theme: document.documentElement.dataset.theme, atDcl: window.__themeAtDcl})"))
        night_context.close()
        browser.close()

    check("no_uncaught_page_errors", not page_errors, page_errors)
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(item["passed"] for item in results.values()) else 1

if __name__ == "__main__":
    raise SystemExit(main())
