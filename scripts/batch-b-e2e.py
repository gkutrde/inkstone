from __future__ import annotations

import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "C:/inkstone-batch-b"
DOC = WORKSPACE + "/sample.md"
LONG_A = WORKSPACE + "/long-a.md"
LONG_B = WORKSPACE + "/long-b.md"
results: dict[str, object] = {}
errors: list[str] = []


def flush(page) -> str:
    page.wait_for_timeout(100)
    return page.evaluate("""async () => {
      if (window.__inkTest) {
        const markdown = await window.__inkTest.flush();
        if (typeof markdown === 'string') return markdown;
        return window.__inkTest.activeTab().content;
      }
      return '';
    }""")


def boot(browser, docs, active, show_outline=False, recent=None, recent_workspaces=None):
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    prefs = {"autoSave": False, "showOutline": show_outline, "showSidebar": True, "theme": "paper"}
    seed = (
        "window.__PERF_FS = " + json.dumps(docs) + ";"
        "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
        "window.__PERF_DIALOG = null;"
        "window.__PERF_INVALID_UTF8 = [" + json.dumps(WORKSPACE + "/broken.md") + "];"
        "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
        "localStorage.removeItem('inkstone.drafts.v1');"
        "localStorage.setItem('inkstone.settings.v1', " + json.dumps(json.dumps(prefs)) + ");"
    )
    if recent is not None:
        seed += "localStorage.setItem('inkstone.recent.v1', " + json.dumps(json.dumps(recent)) + ");"
    if recent_workspaces is not None:
        seed += "localStorage.setItem('inkstone.workspaces.v1', " + json.dumps(json.dumps(recent_workspaces)) + ");"
    context.add_init_script(seed + "\n" + mock)
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:1420", wait_until="networkidle")
    page.locator(".tree-row").filter(has_text=Path(active).name).first.click()
    try:
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
    except Exception:
        page.screenshot(path="batch-b-boot-error.png", full_page=True)
        print("BOOT_ERRORS", errors)
        print("BOOT_EDITOR_ERROR", page.locator(".editor-error").text_content() if page.locator(".editor-error").count() else "none")
        raise
    page.wait_for_timeout(500)
    return context, page


def open_doc(page, filename):
    page.locator(".tree-row").filter(has_text=filename).first.click()
    page.wait_for_timeout(600)


def scenario_search(browser, out, verify):
    search_doc = WORKSPACE + "/aaa-sample.md"
    docs = {search_doc: "intro\nfoo one\nfoo two", WORKSPACE + "/large.md": "x" * (2 * 1024 * 1024 + 100), WORKSPACE + "/broken.md": "foo"}
    for index in range(51):
        docs[WORKSPACE + f"/note-{index:02d}.md"] = "foo"
    context, page = boot(browser, docs, search_doc)
    page.locator(".search-box input").fill("foo")
    page.wait_for_timeout(700)
    if page.locator(".sidebar-scroll").count():
        page.locator(".sidebar-scroll").evaluate("el => { el.scrollTop = 0; }")
    else:
        print("SEARCH_CONTAINER_MISSING", page.locator("body").inner_text()[:1200], errors)
    summary = page.locator(".search-results").text_content() if page.locator(".search-results").count() else ""
    rows = page.locator(".search-result").count()
    page.screenshot(path=str(out / "search-results.png"), full_page=True)
    results["search"] = {"rows": rows, "summary": summary}
    if verify:
        assert rows == 50, "搜索结果未限制为 50 个文件"
        assert "note-00.md" in summary and "foo one" in summary and "2" in summary, "缺少首片段/行号/命中数"
        assert "50+" in summary or "截断" in summary, "未明确搜索结果被截断"
        assert "跳过" in summary or "无法读取" in summary, "未提示大文件或无法读取文件"
    context.close()


def scenario_table(browser, out, verify):
    markdown = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
    context, page = boot(browser, {DOC: markdown}, DOC)
    page.locator(".milkdown-table-block th").first.click()
    page.keyboard.press("Shift+F10")
    bar = page.locator(".table-quickbar")
    labels = bar.locator("button").evaluate_all("els => els.map(el => ({label:el.getAttribute('aria-label'),disabled:el.disabled}))")
    page.screenshot(path=str(out / "table-toolbar.png"), full_page=True)
    results["table_toolbar"] = labels
    if verify:
        assert any(item["label"] == "删除当前行" for item in labels), "缺少删除当前行"
        assert any(item["label"] == "删除当前列" for item in labels), "缺少删除当前列"
        row_button = bar.get_by_role("button", name="删除当前行")
        assert row_button.is_disabled(), "表头行不应允许删除"
        page.locator(".milkdown-table-block tr").last.locator("td").first.click()
        page.keyboard.press("Shift+F10")
        bar.get_by_role("button", name="删除当前行").click()
        page.wait_for_timeout(250)
        assert page.locator(".milkdown-table-block tr").count() == 2, "删除当前行未生效"
        page.locator(".milkdown-table-block td").first.click()
        page.keyboard.press("Shift+F10")
        bar.get_by_role("button", name="删除当前列").click()
        page.wait_for_timeout(250)
        assert page.locator(".milkdown-table-block tr").first.locator("th,td").count() == 1, "删除当前列未生效"
        page.locator(".milkdown-table-block td").first.click()
        page.keyboard.press("Shift+F10")
        assert bar.get_by_role("button", name="删除当前行").is_disabled(), "最后数据行不应允许删除"
        assert bar.get_by_role("button", name="删除当前列").is_disabled(), "最后一列不应允许删除"
        page.locator(".milkdown-table-block td").first.click()
        page.keyboard.press("Shift+Enter")
        page.keyboard.type("soft")
        page.wait_for_timeout(250)
        text = flush(page)
        results["table_soft_break"] = text
        (out / "table-soft-break.md").write_text(text, encoding="utf-8")
        page.screenshot(path=str(out / "table-soft-break.png"), full_page=True)
        assert "<br" in text or "\\\n" in text, "Shift+Enter 未生成单元格内换行: " + repr(text)
        assert "soft" in text, "软换行后的文本未保存"
        assert page.locator(".milkdown-table-block td").first.locator("br,[data-type=hardbreak]").count() == 1, "编辑器中缺少软换行节点"
        assert page.locator(".milkdown-table-block tr").count() == 2, "Shift+Enter 新增了表格行"
        page.get_by_role("button", name="源码", exact=True).click()
        page.wait_for_selector(".cm-content", timeout=10000)
        page.get_by_role("button", name="编辑", exact=True).click()
        page.wait_for_selector(".milkdown-table-block", timeout=10000)
        page.wait_for_timeout(300)
        assert page.locator(".milkdown-table-block td").first.locator("br,[data-type=hardbreak]").count() == 1, "软换行重新加载后丢失"
        assert "<br" in flush(page), "软换行往返序列化后丢失"
    context.close()


def scenario_find(browser, out, verify):
    context, page = boot(browser, {DOC: "foo one foo two"}, DOC)
    page.keyboard.press("Control+f")
    page.get_by_label("查找内容").fill("foo")
    page.get_by_label("替换为").fill("X")
    page.get_by_label("查找内容").press("Enter")
    active = page.evaluate("document.activeElement && document.activeElement.getAttribute('aria-label')")
    page.keyboard.type("Z")
    markdown = flush(page)
    results["find_focus"] = {"active": active, "markdown": markdown}
    if not verify:
        page.get_by_label("查找内容").fill("foo")
        page.screenshot(path=str(out / "find-replace.png"), full_page=True)
        context.close()
        return
    if verify:
        assert active == "查找内容", "跳转后焦点离开查找输入框"
        assert "Z" not in markdown, "查找后的输入误写正文"
        page.get_by_label("查找内容").fill("foo")
        page.screenshot(path=str(out / "find-replace.png"), full_page=True)
        page.get_by_role("button", name="替换", exact=True).click()
        page.wait_for_timeout(250)
        once = flush(page)
        assert "X one foo two" in once, "当前匹配单处替换失败"
        assert once.count("X") == 1, "单处替换修改了多处"
        page.get_by_role("button", name="替换", exact=True).click()
        page.wait_for_timeout(250)
        twice = flush(page)
        assert "X one X two" in twice, "未选中匹配时未回退替换第一处"
        results["find_single"] = twice
    context.close()
    context, page = boot(browser, {DOC: "foo one foo two"}, DOC)
    page.get_by_role("button", name="源码", exact=True).click()
    page.wait_for_selector(".cm-content", timeout=10000)
    page.keyboard.press("Control+f")
    page.get_by_label("查找内容").fill("foo")
    page.get_by_label("替换为").fill("Y")
    page.get_by_label("查找内容").press("Enter")
    page.get_by_role("button", name="替换", exact=True).click()
    page.wait_for_timeout(250)
    source_once = flush(page)
    results["find_source_single"] = source_once
    if verify:
        assert "Y one foo two" in source_once and source_once.count("Y") == 1, "源码模式单处替换失败"
        assert page.evaluate("Boolean(document.activeElement && document.activeElement.closest('.find-bar'))"), "源码模式替换后焦点离开查找栏"
    context.close()


def scenario_recent_paths(browser, verify):
    folder = WORKSPACE + "/folder"
    inside = folder + "/inside.md"
    docs = {DOC: "sample", inside: "inside", WORKSPACE + "/keep.md": "keep"}
    recent = [
        {"path": DOC, "name": "sample.md", "at": 1},
        {"path": inside, "name": "inside.md", "at": 2},
        {"path": WORKSPACE + "/keep.md", "name": "keep.md", "at": 3},
    ]
    workspaces = [WORKSPACE, folder, "C:/elsewhere"]
    context, page = boot(browser, docs, DOC, recent=recent, recent_workspaces=workspaces)

    def rename_row(name, new_name):
        page.locator(".tree-row").filter(has_text=name).first.click(button="right")
        page.get_by_role("menuitem", name="重命名", exact=True).click()
        page.locator(".prompt-input").fill(new_name)
        page.get_by_role("button", name="重命名", exact=True).click()
        page.wait_for_timeout(350)

    def trash_row(name):
        page.locator(".tree-row").filter(has_text=name).first.click(button="right")
        page.get_by_role("menuitem", name="移到回收站", exact=True).click()
        page.wait_for_timeout(350)

    rename_row("sample.md", "renamed.md")
    renamed = WORKSPACE + "/renamed.md"
    archive = WORKSPACE + "/archive"
    rename_row("folder", "archive")
    stored_rename = page.evaluate("""() => ({
      recent: JSON.parse(localStorage.getItem('inkstone.recent.v1') || '[]'),
      workspaces: JSON.parse(localStorage.getItem('inkstone.workspaces.v1') || '[]'),
      current: localStorage.getItem('inkstone.workspace.v1')
    })""")
    if verify:
        assert renamed in [item["path"] for item in stored_rename["recent"]], "重命名文件未同步最近文稿"
        assert archive + "/inside.md" in [item["path"] for item in stored_rename["recent"]], "重命名目录未同步子文档"
        assert archive in stored_rename["workspaces"], "重命名目录未同步最近工作区"
        assert stored_rename["current"] == WORKSPACE, "重命名子目录误改当前工作区"

    trash_row("renamed.md")
    trash_row("archive")
    stored_trash = page.evaluate("""() => ({
      recent: JSON.parse(localStorage.getItem('inkstone.recent.v1') || '[]'),
      workspaces: JSON.parse(localStorage.getItem('inkstone.workspaces.v1') || '[]'),
      current: localStorage.getItem('inkstone.workspace.v1')
    })""")
    results["recent_paths"] = {"renamed": stored_rename, "trashed": stored_trash}
    if verify:
        remaining = [item["path"] for item in stored_trash["recent"]]
        assert renamed not in remaining and archive + "/inside.md" not in remaining, "删除后仍保留失效最近文稿"
        assert WORKSPACE + "/keep.md" in remaining, "删除目录误删无关最近文稿"
        assert archive not in stored_trash["workspaces"], "删除后仍保留失效最近工作区"
        assert stored_trash["current"] == WORKSPACE, "删除子目录误清空当前工作区"
        assert page.locator(".toast.error").count() == 0, "路径同步后出现读取错误"
    context.close()


def scenario_scroll(browser, out, verify):
    long_text = "\n\n".join(f"line {index}" for index in range(240))
    context, page = boot(browser, {LONG_A: long_text, LONG_B: long_text}, LONG_A)
    page.locator(".editor-viewport").evaluate("el => { el.scrollTop = 600; el.dispatchEvent(new Event('scroll')); }")
    before = page.locator(".editor-viewport").evaluate("el => ({top:el.scrollTop,max:el.scrollHeight-el.clientHeight})")
    open_doc(page, "long-b.md")
    open_doc(page, "long-a.md")
    page.wait_for_timeout(500)
    tab_restored = page.locator(".editor-viewport").evaluate("el => el.scrollTop")
    if verify:
        assert before["top"] >= 550, "长文高度不足，未形成有效滚动测试"
        assert abs(tab_restored - before["top"]) <= 2, "切换标签后未恢复滚动位置: " + repr({"before": before, "after": tab_restored})

    page.get_by_role("button", name="源码", exact=True).click()
    page.wait_for_selector(".cm-content", timeout=10000)
    page.locator(".editor-viewport").evaluate("el => { el.scrollTop = 400; el.dispatchEvent(new Event('scroll')); }")
    source_before = page.locator(".editor-viewport").evaluate("el => ({top:el.scrollTop,max:el.scrollHeight-el.clientHeight})")
    page.get_by_role("button", name="编辑", exact=True).click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=10000)
    page.wait_for_timeout(300)
    rich_restored = page.locator(".editor-viewport").evaluate("el => el.scrollTop")
    page.get_by_role("button", name="源码", exact=True).click()
    page.wait_for_selector(".cm-content", timeout=10000)
    page.wait_for_timeout(300)
    source_restored = page.locator(".editor-viewport").evaluate("el => el.scrollTop")
    results["scroll"] = {
        "tab": {"before": before, "after": tab_restored},
        "mode": {"rich": rich_restored, "sourceBefore": source_before, "source": source_restored},
    }
    page.screenshot(path=str(out / "scroll-source-restored.png"), full_page=True)
    if verify:
        assert abs(rich_restored - before["top"]) <= 2, "切回富文本后未恢复其滚动位置"
        assert source_before["top"] >= 350 and abs(source_restored - source_before["top"]) <= 2, "切回源码后未恢复其滚动位置: " + repr({"before": source_before, "after": source_restored, "rich": rich_restored})
    context.close()


def scenario_outline(browser, verify):
    markdown = "# Real\n\n<!--\n# fake\n-->\n\n# Next"
    context, page = boot(browser, {DOC: markdown}, DOC, show_outline=True)
    text = page.locator(".outline-panel").inner_text() if page.locator(".outline-panel").count() else ""
    results["outline"] = text
    if verify:
        assert "fake" not in text, "HTML 注释中的伪标题进入大纲"
        assert "Real" in text and "Next" in text, "真实标题丢失"
    context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="batch-b-after")
    parser.add_argument("--assert", action="store_true", dest="verify")
    parser.add_argument("--only", choices=["all", "search", "table", "find", "recent", "scroll", "outline"], default="all")
    args = parser.parse_args()
    out = ROOT.parent / "analysis" / "batch-b" / args.label
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        scenarios = {
            "search": lambda: scenario_search(browser, out, args.verify),
            "table": lambda: scenario_table(browser, out, args.verify),
            "find": lambda: scenario_find(browser, out, args.verify),
            "recent": lambda: scenario_recent_paths(browser, args.verify),
            "scroll": lambda: scenario_scroll(browser, out, args.verify),
            "outline": lambda: scenario_outline(browser, args.verify),
        }
        for name, scenario in scenarios.items():
            if args.only in ("all", name):
                scenario()
        browser.close()
    results["errors"] = errors
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    if args.verify:
        assert not errors, "页面错误: " + "; ".join(errors)


if __name__ == "__main__":
    main()
