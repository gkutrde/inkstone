from __future__ import annotations

import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "C:/inkstone-data-safety"
DOC = WORKSPACE + "/sample.md"
NEW_DOC = WORKSPACE + "/saved-as.md"
VISIBLE = """---
title: foo
---

[链接][foo]

[foo]: https://example.com/foo

正文 foo
"""
results: dict[str, object] = {}
errors: list[str] = []


def flush(page) -> str:
    page.wait_for_timeout(100)
    return page.evaluate("""async () => {
      if (window.__inkTest) await window.__inkTest.flush();
      return window.__inkTest ? window.__inkTest.activeTab().content : '';
    }""")


def boot(browser, content="正文", auto_save=False, dialog=None, fail_writes=0):
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    prefs = {"autoSave": auto_save, "showOutline": False, "showSidebar": True, "theme": "paper"}
    seed = (
        "window.__PERF_FS = " + json.dumps({DOC: content}) + ";"
        "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
        "window.__PERF_DIALOG = " + json.dumps(dialog) + ";"
        "window.__FAIL_WRITE_COUNT = " + str(fail_writes) + ";"
        "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
        "localStorage.removeItem('inkstone.drafts.v1');"
        "localStorage.setItem('inkstone.settings.v1', " + json.dumps(json.dumps(prefs)) + ");"
    )
    fault = """
const originalInvoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = async function(cmd, args, options) {
  if (cmd === 'write_text_file' && window.__FAIL_WRITE_COUNT > 0) {
    window.__FAIL_WRITE_COUNT -= 1;
    throw new Error('目标文件为只读，无法保存');
  }
  return originalInvoke.call(this, cmd, args, options);
};
"""
    context.add_init_script(seed + "\n" + mock + "\n" + fault)
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:1420", wait_until="networkidle")
    page.locator(".tree-row").filter(has_text="sample.md").first.click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
    page.wait_for_timeout(500)
    return context, page


def type_body(page, text="local"):
    editor = page.locator(".milkdown .ProseMirror")
    editor.click()
    page.keyboard.press("Control+End")
    page.keyboard.type(text, delay=40)


def save_as(page, path):
    page.evaluate("path => { window.__PERF_DIALOG = path; }", path)
    page.keyboard.press("Control+Shift+S")
    page.wait_for_timeout(500)


def scenario_save_as(browser, out: Path, verify: bool, delete=False) -> None:
    context, page = boot(browser, "original")
    key = "save_as_deleted" if delete else "save_as_external_change"
    type_body(page)
    if delete:
        page.evaluate("path => { delete window.__perfFs.files[path]; delete window.__perfFs.meta[path]; }", DOC)
    else:
        page.evaluate("""async path => {
          await window.__TAURI_INTERNALS__.invoke('write_text_file', {
            path, content: 'external version'
          });
        }""", DOC)
    save_as(page, DOC)
    conflict = page.locator(".conflict-banner").count() > 0
    disk = page.evaluate("path => window.__perfFs.files[path] ?? null", DOC)
    results[key] = {"conflict": conflict, "disk": disk}
    if verify:
        assert conflict, key + " 未保留冲突校验"
        assert disk is None if delete else disk == "external version", key + " 覆盖了外部版本"
    context.close()


def scenario_save_as_new_path(browser, verify: bool) -> None:
    context, page = boot(browser, "original")
    type_body(page, "local")
    page.evaluate("""async () => {
      await window.__TAURI_INTERNALS__.invoke('create_file', {
        parent: 'C:/inkstone-data-safety', name: 'saved-as.md', content: ''
      });
    }""")
    save_as(page, NEW_DOC)
    saved = page.evaluate("path => window.__perfFs.files[path] ?? null", NEW_DOC)
    results["save_as_new_path"] = saved
    if verify:
        assert saved and "local" in saved, "真正另存为新路径失败"
    context.close()


def scenario_visible_replace(browser, verify: bool) -> None:
    context, page = boot(browser, VISIBLE)
    page.keyboard.press("Control+f")
    page.get_by_label("查找内容").fill("foo")
    page.get_by_label("替换为").fill("bar")
    shown = page.locator(".find-count").inner_text()
    page.get_by_role("button", name="全部替换").click()
    page.wait_for_timeout(400)
    markdown = flush(page)
    results["visible_replace"] = {"shown": shown, "markdown": markdown}
    if verify:
        assert "title: foo" in markdown, "富文本替换了前言"
        assert "[foo]: https://example.com/foo" in markdown, "富文本替换了引用定义"
        assert "正文 bar" in markdown, "可见正文未被替换"
        assert shown == "1 处", "查找计数与可见文本域不一致"
    context.close()


def scenario_save_failure(browser, out: Path, verify: bool) -> None:
    context, page = boot(browser, "original", auto_save=True, fail_writes=3)
    type_body(page, "x")
    page.wait_for_timeout(1700)
    label = page.locator(".save-state").inner_text()
    banner = page.locator(".conflict-banner")
    visible = banner.count() > 0
    text = banner.inner_text() if visible else ""
    page.screenshot(path=str(out / "save-failure.png"), full_page=True)
    results["save_failure"] = {"label": label, "visible": visible, "text": text}
    if verify:
        assert visible and "保存失败" in text, "普通保存失败没有持久错误横幅"
        assert "保存失败" in label, "状态栏没有保存失败状态"
    context.close()


def scenario_retry_success(browser, verify: bool) -> None:
    context, page = boot(browser, "original", auto_save=True, fail_writes=1)
    type_body(page, "x")
    page.wait_for_timeout(3900)
    disk = page.evaluate("path => window.__perfFs.files[path]", DOC)
    label = page.locator(".save-state").inner_text()
    banner = page.locator(".conflict-banner").count()
    results["retry_success"] = {"disk": disk, "label": label, "banner": banner}
    if verify:
        assert disk.strip().endswith("x"), "退避重试没有写入最新内容"
        assert banner == 0 and "已保存" in label, "重试成功后未清除错误状态"
    context.close()


def scenario_retry_limit(browser, verify: bool) -> None:
    context, page = boot(browser, "original", auto_save=True, fail_writes=10)
    type_body(page, "x")
    page.wait_for_timeout(15800)
    remaining = page.evaluate("window.__FAIL_WRITE_COUNT")
    banner = page.locator(".conflict-banner").count()
    results["retry_limit"] = {"remainingFailures": remaining, "banner": banner}
    if verify:
        assert remaining == 6, "自动保存没有按 3 次退避重试上限停止"
        assert banner == 1, "达到重试上限后未保留错误入口"
        page.evaluate("window.__FAIL_WRITE_COUNT = 0")
        page.get_by_role("button", name="重试").click()
        page.wait_for_timeout(600)
        disk = page.evaluate("path => window.__perfFs.files[path]", DOC)
        results["retry_limit"]["manualDisk"] = disk
        results["retry_limit"]["manualBanner"] = page.locator(".conflict-banner").count()
        assert disk.strip().endswith("x"), "手动重试没有保存最新内容"
        assert results["retry_limit"]["manualBanner"] == 0, "手动重试成功后未清除错误"
    context.close()


def composing_event(page, selector: str, key: str) -> None:
    page.locator(selector).evaluate("""(el, key) => {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, isComposing: true
      }));
    }""", key)


def scenario_ime(browser, verify: bool) -> None:
    context, page = boot(browser)
    page.keyboard.press("Control+f")
    composing_event(page, '.find-bar input[aria-label="查找内容"]', "Escape")
    find_open = page.locator(".find-bar").count() > 0
    page.keyboard.press("Control+k")
    page.locator(".command-search-row input").fill("保存")
    composing_event(page, ".command-search-row input", "Enter")
    command_open = page.locator(".command-dialog").count() > 0
    results["ime_guards"] = {"findOpen": find_open, "commandOpen": command_open}
    if verify:
        assert find_open, "组字 Escape 关闭了查找栏"
        assert command_open, "组字 Enter 执行了命令"
    context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="batch-a-after")
    parser.add_argument("--assert", action="store_true", dest="verify")
    args = parser.parse_args()
    out = ROOT.parent / "analysis" / "data-safety" / args.label
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        scenario_save_as(browser, out, args.verify)
        scenario_save_as(browser, out, args.verify, delete=True)
        scenario_save_as_new_path(browser, args.verify)
        scenario_visible_replace(browser, args.verify)
        scenario_save_failure(browser, out, args.verify)
        scenario_retry_success(browser, args.verify)
        scenario_retry_limit(browser, args.verify)
        scenario_ime(browser, args.verify)
        browser.close()
    results["errors"] = errors
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    if args.verify:
        assert not errors, "页面错误: " + "; ".join(errors)


if __name__ == "__main__":
    main()
