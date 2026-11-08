from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "C:/inkstone-editor-ux"
DOCS = {
    "table.md": """# 表格对齐验收

| 名称 | 值 |
| --- | --- |
| A | 1 |
| B | 2 |
""",
    "javascript.md": """# JavaScript 富文本代码块

```javascript

```
""",
    "source-javascript.md": """# JavaScript 源码代码块

```javascript

```
""",
    "python.md": """# Python 缩进

```python

```
""",
    "html.md": """# HTML 缩进

```html

```
""",
    "plain.md": """# 无语言代码块

```

```
""",
    "prose.md": """# 正文回归

- item""",
    "cpp.md": """# C++ 富文本预览

```cpp

```
""",
    "source-cpp.md": """# C++ 源码预览

```cpp

```
""",
    "cpp-escape.md": """# C++ Escape 预览

```cpp

```
""",
    "cpp-brace.md": """# C++ 大括号换行

```cpp

```
""",
    "source-cpp-brace.md": """# C++ 源码大括号换行

```cpp

```
""",
    "cpp-sample.md": """# C++ 示例换行

```cpp

```
""",
    "source-cpp-sample.md": """# C++ 源码示例换行

```cpp

```
""",
    "cpp-space.md": """# C++ 大括号空格

```cpp

```
""",
}
FILES = {WORKSPACE + "/" + name: body for name, body in DOCS.items()}
errors: list[str] = []
results: dict[str, object] = {}


def flush(page) -> str:
    page.wait_for_timeout(100)
    value = page.evaluate("""async () => {
      if (window.__inkTest) await window.__inkTest.flush();
      return window.__inkTest ? window.__inkTest.activeTab().content : '';
    }""")
    page.wait_for_timeout(50)
    return value


def table_divider_cells(markdown: str) -> list[str]:
    for line in markdown.splitlines():
        if re.fullmatch(r"\|[-: |]+\|", line.strip()):
            return [cell.strip() for cell in line.strip().strip("|").split("|")]
    return []


def open_doc(page, name: str) -> None:
    page.locator(".tree-row").filter(has_text=name).first.click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
    page.wait_for_timeout(500)


def switch_mode(page, source: bool) -> None:
    page.locator(".mode-switch button").nth(1 if source else 0).click()
    selector = ".source-editor-shell .cm-editor" if source else ".milkdown .ProseMirror"
    page.wait_for_selector(selector, timeout=30000)
    page.wait_for_timeout(500)


def table_case(page, out: Path, verify: bool) -> None:
    open_doc(page, "table.md")
    page.locator(".milkdown-table-block td").nth(1).click()
    page.keyboard.press("Shift+F10")
    bar = page.locator(".table-quickbar")
    page.wait_for_timeout(250)
    labels = bar.locator("button").evaluate_all("els => els.map(el => el.getAttribute('aria-label'))")
    results["table_before_buttons"] = labels
    page.screenshot(path=str(out / "table-toolbar.png"), full_page=True)
    if not bar.get_by_role("button", name="当前列居中").count():
        results["table_alignment"] = "missing"
        return
    states = {}
    for label in ("当前列居中", "当前列居右", "当前列居左"):
        bar.get_by_role("button", name=label).click()
        page.wait_for_timeout(200)
        markdown = flush(page)
        states[label] = {
            "markdown": markdown,
            "pressed": bar.get_by_role("button", name=label).get_attribute("aria-pressed"),
            "alignments": page.locator(".milkdown-table-block th, .milkdown-table-block td").evaluate_all(
                "els => els.map(el => getComputedStyle(el).textAlign)"
            ),
        }
        if verify:
            assert states[label]["pressed"] == "true", label + " 未显示选中态"
            cells = table_divider_cells(markdown)
            expected = {"当前列居中": r":-+:", "当前列居右": r"-+:", "当前列居左": r"-+"}[label]
            assert len(cells) == 2 and re.fullmatch(r"-+", cells[0]), "其他列对齐被修改"
            assert re.fullmatch(expected, cells[1]), label + " 未写入 Markdown 分隔线"
            expected_css = {"当前列居中": "center", "当前列居右": "right", "当前列居左": "left"}[label]
            assert states[label]["alignments"][1::2] == [expected_css] * 3, label + " 未应用到整列"
    bar.get_by_role("button", name="当前列居中").click()
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "table-toolbar.png"), full_page=True)
    switch_mode(page, True)
    markdown = flush(page)
    results["table_alignment"] = {"states": states, "source": markdown}
    if verify:
        cells = table_divider_cells(markdown)
        assert len(cells) == 2 and re.fullmatch(r"-+", cells[0]), "模式切换修改了其他列"
        assert re.fullmatch(r":-+:", cells[1]), "当前列居中没有通过模式往返"
    switch_mode(page, False)
    assert page.locator(".milkdown-table-block tr").count() == 3, "表格模式往返后行数变化"


def enter_without_completions(page, out: Path, source: bool = False) -> None:
    content = page.locator(".source-editor-shell .cm-content" if source else ".milkdown-code-block .cm-content")
    content.click()
    if source:
      page.keyboard.press("Control+Home")
      for _ in range(3):
        page.keyboard.press("ArrowDown")
      page.keyboard.press("End")
    page.keyboard.type("if (true) {", delay=35)
    page.keyboard.press("Escape")
    page.keyboard.press("Enter")
    page.wait_for_timeout(250)
    after_enter = flush(page)
    page.keyboard.type("fun", delay=100)
    page.wait_for_timeout(800)
    tooltip = page.locator(".cm-tooltip-autocomplete")
    visible = tooltip.count() > 0 and tooltip.first.is_visible()
    items = tooltip.locator(".cm-completionLabel").all_inner_texts() if visible else []
    tooltip_text = tooltip.inner_text() if visible else ""
    page.screenshot(path=str(out / ("source-javascript.png" if source else "rich-javascript.png")), full_page=True)
    if visible:
        page.keyboard.press("Tab")
        page.wait_for_timeout(300)
    after_tab = flush(page)
    page.keyboard.press("Tab")
    page.wait_for_timeout(150)
    after_second_tab = flush(page)
    results["source_javascript" if source else "rich_javascript"] = {
        "afterEnter": after_enter,
        "completionVisible": visible,
        "ghostVisible": page.locator(".cm-ghost-completion").count(),
        "items": items[:12],
        "tooltipText": tooltip_text,
        "afterTab": after_tab,
        "afterSecondTab": after_second_tab,
    }


def simple_enter(page, doc: str, text: str, key: str) -> str:
    open_doc(page, doc)
    page.locator(".milkdown-code-block .cm-content").click()
    page.keyboard.type(text, delay=40)
    page.keyboard.press("Escape")
    page.keyboard.press("Enter")
    page.wait_for_timeout(250)
    value = flush(page)
    results[key] = value
    return value


def cpp_body(markdown: str) -> str:
    return markdown.split("```cpp\n", 1)[1].split("```", 1)[0]


def focus_code(page, source: bool = False) -> None:
    selector = ".source-editor-shell .cm-content" if source else ".milkdown-code-block .cm-content"
    page.locator(selector).click()
    if source:
        page.keyboard.press("Control+Home")
        for _ in range(3):
            page.keyboard.press("ArrowDown")
        page.keyboard.press("End")


def ghost_case(page, doc: str, key: str, out: Path, source: bool, verify: bool) -> None:
    open_doc(page, doc)
    if source:
        switch_mode(page, True)
    focus_code(page, source)
    page.keyboard.type("in", delay=80)
    page.wait_for_timeout(250)
    page.keyboard.type("t")
    page.wait_for_timeout(250)
    ghost = page.locator(".cm-ghost-completion")
    early_count = ghost.count()
    page.wait_for_timeout(550)
    visible = ghost.count() > 0 and ghost.first.is_visible()
    text = ghost.first.text_content() if visible else ""
    opacity = float(ghost.first.evaluate("el => getComputedStyle(el).opacity")) if visible else None
    page.screenshot(path=str(out / (key + ".png")), full_page=True)
    before_accept = flush(page)
    if visible:
        page.keyboard.press("Tab")
        page.wait_for_timeout(250)
    after_accept = flush(page)
    page.screenshot(path=str(out / (key + "-accepted.png")), full_page=True)
    results[key] = {
        "earlyCount": early_count,
        "visible": visible,
        "text": text,
        "opacity": opacity,
        "beforeAccept": before_accept,
        "afterAccept": after_accept,
        "ghostAfterAccept": page.locator(".cm-ghost-completion").count(),
    }
    if verify:
        assert early_count == 0, key + " 在输入早期显示了幽灵预览"
        assert not visible and text == "" and opacity is None, key + " 仍显示幽灵预览"
        assert cpp_body(before_accept).strip() == "int", key + " 输入被预览污染"
        assert cpp_body(after_accept) == cpp_body(before_accept), key + " Tab 仍插入代码片段"
        assert results[key]["ghostAfterAccept"] == 0, key + " 幽灵预览未保持关闭"
        assert page.locator(".cm-tooltip-autocomplete").count() == 0, key + " 仍显示补全弹窗"


def ghost_escape_case(page, out: Path, verify: bool) -> None:
    open_doc(page, "cpp-escape.md")
    focus_code(page)
    page.keyboard.type("int", delay=80)
    page.wait_for_timeout(700)
    visible = page.locator(".cm-ghost-completion").count() > 0
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    remaining = page.locator(".cm-ghost-completion").count()
    results["cpp_escape"] = {"before": visible, "after": remaining}
    if verify:
        assert not visible and remaining == 0, "幽灵预览在 Escape 场景中仍然出现"


def cpp_sample_case(page, doc: str, key: str, out: Path, source: bool, verify: bool) -> None:
    open_doc(page, doc)
    if source:
        switch_mode(page, True)
    focus_code(page, source)
    page.keyboard.type("else if (money == 100) {", delay=30)
    page.keyboard.press("Enter")
    page.wait_for_timeout(250)
    body = cpp_body(flush(page))
    completion_count = page.locator(".cm-tooltip-autocomplete").count()
    ghost_count = page.locator(".cm-ghost-completion").count()
    page.screenshot(path=str(out / (key + ".png")), full_page=True)
    results[key] = {"body": body, "completions": completion_count, "ghosts": ghost_count}
    if verify:
        expected = "else if (money == 100)\n{\n    \n}\n"
        assert body == expected, key + " 未生成 Allman 四空格结构: " + repr(body)
        assert completion_count == 0 and ghost_count == 0, key + " 仍显示补全或幽灵预览"


def brace_case(page, doc: str, key: str, out: Path, source: bool, space: bool, verify: bool) -> None:
    open_doc(page, doc)
    if source:
        switch_mode(page, True)
    focus_code(page, source)
    page.keyboard.type("{")
    page.keyboard.press("Space" if space else "Enter")
    page.wait_for_timeout(200)
    markdown = flush(page)
    body = cpp_body(markdown)
    page.screenshot(path=str(out / (key + ".png")), full_page=True)
    results[key] = body
    if verify and space:
        assert body.strip() == "{ }", "Space 不应展开大括号"
    elif verify:
        lines = body.splitlines()
        assert len(lines) == 3 and lines[0] == "{" and lines[2] == "}", key + " 未展开为三行"
        assert lines[1] == "    ", key + " 中间行未按 C++ 四空格缩进: " + repr(lines[1])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="after")
    parser.add_argument("--assert", action="store_true", dest="verify")
    args = parser.parse_args()
    out = ROOT.parent / "analysis" / "editor-coding-ux" / args.label
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
        prefs = {"autoSave": False, "showOutline": False, "showSidebar": True, "theme": "paper"}
        seed = (
            "window.__PERF_FS = " + json.dumps(FILES) + ";"
            "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
            "window.__PERF_DIALOG = null;"
            "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
            "localStorage.removeItem('inkstone.drafts.v1');"
            "localStorage.setItem('inkstone.settings.v1', " + json.dumps(json.dumps(prefs)) + ");"
        )
        context.add_init_script(seed + "\n" + mock)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://localhost:1420", wait_until="networkidle")
        table_case(page, out, args.verify)
        open_doc(page, "javascript.md")
        enter_without_completions(page, out)
        open_doc(page, "source-javascript.md")
        switch_mode(page, True)
        enter_without_completions(page, out, True)
        simple_enter(page, "python.md", "def main():", "python_enter")
        simple_enter(page, "html.md", "<div>", "html_enter")
        open_doc(page, "plain.md")
        page.locator(".milkdown-code-block .cm-content").click()
        page.keyboard.type("x")
        page.wait_for_timeout(300)
        page.keyboard.press("Escape")
        # Escape temporarily enables CodeMirror's Tab-focus accessibility mode.
        # A non-modifier editing key returns to normal editing without changing text.
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("Tab")
        page.wait_for_timeout(150)
        tabbed = flush(page)
        tabbed_dom = page.locator(".milkdown-code-block .cm-content").inner_text()
        page.keyboard.press("Shift+Tab")
        page.wait_for_timeout(150)
        dedented = flush(page)
        results["plain_tab"] = {"tabbed": tabbed, "tabbedDom": tabbed_dom, "dedented": dedented}
        open_doc(page, "prose.md")
        switch_mode(page, True)
        page.locator(".source-editor-shell .cm-content").click()
        page.keyboard.press("Control+End")
        page.keyboard.press("Enter")
        prose = flush(page)
        results["prose_enter"] = prose
        ghost_case(page, "cpp.md", "cpp_ghost", out, False, args.verify)
        ghost_case(page, "source-cpp.md", "source_cpp_ghost", out, True, args.verify)
        ghost_escape_case(page, out, args.verify)
        brace_case(page, "cpp-brace.md", "cpp_brace_enter", out, False, False, args.verify)
        brace_case(page, "source-cpp-brace.md", "source_cpp_brace_enter", out, True, False, args.verify)
        cpp_sample_case(page, "cpp-sample.md", "cpp_sample_enter", out, False, args.verify)
        cpp_sample_case(page, "source-cpp-sample.md", "source_cpp_sample_enter", out, True, args.verify)
        brace_case(page, "cpp-space.md", "cpp_brace_space", out, False, True, args.verify)
        if args.verify:
            for key in ("rich_javascript", "source_javascript"):
                item = results[key]
                assert re.search(r"if \(true\) \{\n[ \t]+", item["afterEnter"]), key + " Enter 未自动缩进"
                assert not item["completionVisible"], key + " 仍弹出补全建议"
                assert item["items"] == [] and item["tooltipText"] == "", key + " 补全列表未清空"
                assert item["ghostVisible"] == 0, key + " 仍显示幽灵预览"
                assert "function" not in item["afterTab"], key + " Tab 仍接受代码片段"
                assert "if (true) {\n  fun\n}\n" in item["afterTab"], key + " 第一次 Tab 未作为两空格缩进"
                assert "if (true) {\n    fun\n}\n" in item["afterSecondTab"], key + " 第二次 Tab 未继续缩进"
                assert "\t" not in item["afterTab"], key + " Tab 输入包含制表符"
            assert re.search(r"def main\(\):\n[ \t]+", results["python_enter"]), "Python Enter 未自动缩进"
            assert re.search(r"<div>\n[ \t]+", results["html_enter"]), "HTML Enter 未自动缩进"
            assert re.search(r"\n[ \t]+x", tabbed), "无补全时 Tab 未缩进"
            assert re.search(r"\nx", dedented), "Shift+Tab 未反缩进"
            assert prose.endswith("\n- "), "普通 Markdown 列表的 Enter 行为被改变"
        results["errors"] = errors
        (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(results, ensure_ascii=False, indent=2))
        browser.close()
        if args.verify:
            assert not errors, "页面运行错误: " + "; ".join(errors)


if __name__ == "__main__":
    main()
