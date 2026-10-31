from __future__ import annotations

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "analysis" / "editor-regressions"
OUT.mkdir(parents=True, exist_ok=True)
WORKSPACE = "C:/review-workspace"
DOC_PATH = WORKSPACE + "/editor-bugs.md"
MARKDOWN = """# 编辑器回归

```text
const answer = 42;
```

| 名称 | 值 |
| --- | --- |
| 第一行 | 1 |
| 第二行 | 2 |
| 第三行 | 3 |

段落末尾
"""

results: dict[str, object] = {}
errors: list[str] = []


def table_rows(page) -> int:
    return page.locator(".milkdown-table-block tr").count()


def switch_mode(page, mode: str) -> None:
    page.locator(".mode-switch button").nth(1 if mode == "source" else 0).click()
    selector = ".source-editor-shell .cm-editor" if mode == "source" else ".milkdown .ProseMirror"
    page.wait_for_selector(selector, timeout=30000)
    page.wait_for_timeout(500)


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 860})
        mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
        prefs = {"autoSave": False, "showOutline": False, "showSidebar": True, "theme": "paper"}
        seed = (
            "window.__PERF_FS = " + json.dumps({DOC_PATH: MARKDOWN}) + ";"
            "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
            "window.__PERF_DIALOG = null;"
            "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
            "localStorage.removeItem('inkstone.drafts.v1');"
            "localStorage.setItem('inkstone.settings.v1', " + json.dumps(json.dumps(prefs)) + ");"
        )
        context.add_init_script(seed + "\n" + mock)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://127.0.0.1:1420", wait_until="networkidle")
        page.locator(".tree-row").filter(has_text="editor-bugs.md").click()
        page.wait_for_selector(".milkdown-code-block .language-button", timeout=30000)
        page.wait_for_timeout(700)

        results["initial_table_rows"] = table_rows(page)
        language = page.locator(".milkdown-code-block .language-button").first
        language.click()
        page.wait_for_selector(".language-picker .list-wrapper", timeout=5000)
        page.wait_for_timeout(250)
        results["language_picker"] = page.evaluate("""() => {
          const picker = document.querySelector('.language-picker');
          const list = document.querySelector('.language-list');
          const wrapper = document.querySelector('.language-picker .list-wrapper');
          const rect = wrapper.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, Math.min(rect.bottom - 20, innerHeight - 1));
          const ancestors = [];
          let node = wrapper.parentElement;
          while (node) {
            const style = getComputedStyle(node);
            if (style.overflow !== 'visible' || style.overflowY !== 'visible' || style.overflowX !== 'visible') {
              const r = node.getBoundingClientRect();
              ancestors.push({className: node.className, overflow: style.overflow, overflowY: style.overflowY, rect: {top:r.top,bottom:r.bottom}});
            }
            node = node.parentElement;
          }
          return {
            items: document.querySelectorAll('.language-list-item').length,
            listClientHeight: list.clientHeight,
            listScrollHeight: list.scrollHeight,
            wrapperRect: {top:rect.top,bottom:rect.bottom,height:rect.height},
            hitClass: hit && hit.className,
            hitInsidePicker: Boolean(hit && hit.closest('.language-picker')),
            clippingAncestors: ancestors
          };
        }""")
        page.screenshot(path=str(OUT / "language-picker.png"), full_page=True)
        page.locator(".language-list").hover()
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(200)
        results["language_scroll_top"] = page.locator(".language-list").evaluate("el => el.scrollTop")
        page.locator(".language-list").evaluate("el => { el.scrollTop = 0; }")
        try:
            page.locator(".language-picker .search-input").fill("python")
            item = page.locator('.language-list-item[data-language="Python"]')
            item.click(timeout=2500)
            page.wait_for_timeout(250)
            results["language_selection"] = language.inner_text()
        except Exception as error:
            results["language_selection_error"] = str(error).splitlines()[0]
        page.keyboard.press("Escape")

        cycle_rows = []
        cycle_source = []
        for _ in range(2):
            switch_mode(page, "source")
            cycle_source.append(page.evaluate("() => window.__inkTest.activeTab().content"))
            switch_mode(page, "rich")
            cycle_rows.append(table_rows(page))
        results["table_rows_after_cycles"] = cycle_rows
        results["table_source_after_cycles"] = cycle_source
        page.screenshot(path=str(OUT / "table-after-cycles.png"), full_page=True)

        # Exercise rows created in the rich editor, then switch while the table
        # still owns the selection instead of only round-tripping a loaded file.
        page.locator(".milkdown-table-block td").last.click()
        page.keyboard.press("End")
        page.keyboard.type("X")
        for name, value in (("第四行", "4"), ("第五行", "5")):
            page.keyboard.press("Tab")
            page.keyboard.type(name)
            page.keyboard.press("Tab")
            page.keyboard.type(value)
        results["table_rows_after_rich_insert"] = table_rows(page)
        switch_mode(page, "source")
        results["table_source_after_rich_insert"] = page.evaluate("() => window.__inkTest.activeTab().content")
        switch_mode(page, "rich")
        results["table_rows_after_rich_insert_roundtrip"] = table_rows(page)

        editor = page.locator(".milkdown .ProseMirror")
        editor.locator("p").last.click()
        page.keyboard.press("End")
        page.keyboard.type("RICH_UNDO")
        page.wait_for_timeout(300)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(300)
        results["rich_ctrl_z_restores"] = "RICH_UNDO" not in editor.inner_text()
        editor.locator("p").last.click()
        page.keyboard.press("End")
        page.keyboard.type("RICH_BUTTON")
        page.wait_for_timeout(300)
        undo = page.get_by_role("button", name="撤销", exact=True)
        redo = page.get_by_role("button", name="重做", exact=True)
        results["history_buttons_present"] = undo.count() == 1 and redo.count() == 1
        if undo.count() and redo.count():
            undo.click()
            page.wait_for_timeout(250)
            results["rich_undo_button_restores"] = "RICH_BUTTON" not in editor.inner_text()
            redo.click()
            page.wait_for_timeout(250)
            results["rich_redo_button_reapplies"] = "RICH_BUTTON" in editor.inner_text()

        switch_mode(page, "source")
        source = page.locator(".source-editor-shell .cm-content")
        source.click()
        page.keyboard.press("Control+End")
        page.keyboard.type("SOURCE_BUTTON")
        page.wait_for_timeout(250)
        if undo.count() and redo.count():
            undo.click()
            page.wait_for_timeout(250)
            results["source_undo_button_restores"] = "SOURCE_BUTTON" not in source.inner_text()
            redo.click()
            page.wait_for_timeout(250)
            results["source_redo_button_reapplies"] = "SOURCE_BUTTON" in source.inner_text()
        else:
            page.keyboard.press("Control+z")
            page.wait_for_timeout(250)
            results["source_ctrl_z_restores"] = "SOURCE_BUTTON" not in source.inner_text()

        results["page_errors"] = errors
        print(json.dumps(results, ensure_ascii=False, indent=2))
        browser.close()

        expected = [
            results.get("initial_table_rows") == 4,
            results.get("language_selection") == "Python",
            isinstance(results.get("language_picker"), dict) and results["language_picker"].get("hitInsidePicker") is True,
            isinstance(results.get("language_scroll_top"), (int, float)) and results["language_scroll_top"] > 0,
            cycle_rows == [4, 4],
            results.get("table_rows_after_rich_insert") == 6,
            results.get("table_rows_after_rich_insert_roundtrip") == 6,
            results.get("rich_ctrl_z_restores") is True,
            results.get("history_buttons_present") is True,
            results.get("rich_undo_button_restores") is True,
            results.get("rich_redo_button_reapplies") is True,
            results.get("source_undo_button_restores") is True,
            results.get("source_redo_button_reapplies") is True,
            not errors,
        ]
        if not all(expected):
            raise SystemExit(1)


if __name__ == "__main__":
    main()
