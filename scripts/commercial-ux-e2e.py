from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT.parent / "analysis" / "ios-liquid-glass" / "commercial-after"


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 Inkstone 商业桌面软件的键盘流与焦点管理")
    parser.add_argument("--url", default="http://127.0.0.1:1420")
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    checks: list[str] = []
    errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.add_init_script(mock)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url, wait_until="networkidle")
        page.locator(".sidebar-compose").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=20000)

        page.locator(".command-trigger").click()
        command_input = page.locator(".command-search-row input")
        command_input.press("End")
        page.wait_for_timeout(120)
        end_state = page.evaluate("""() => {
          const active = document.querySelector('.command-option.is-active');
          const results = document.querySelector('.command-results');
          const a = active.getBoundingClientRect(), r = results.getBoundingClientRect();
          return { visible: a.bottom <= r.bottom && a.top >= r.top, scrollTop: results.scrollTop };
        }""")
        assert end_state["visible"] and end_state["scrollTop"] > 0, end_state
        page.screenshot(path=str(args.out / "01-command-end.png"))
        command_input.press("Home")
        page.wait_for_timeout(100)
        assert page.evaluate("""() => {
          const a = document.querySelector('.command-option.is-active').getBoundingClientRect();
          const r = document.querySelector('.command-results').getBoundingClientRect();
          return a.top >= r.top && a.bottom <= r.bottom;
        }""")
        checks.append("命令中心 Home/End 自动滚动选中项")
        page.keyboard.press("Escape")
        page.wait_for_selector(".command-backdrop", state="detached", timeout=2000)

        export = page.locator("button[title='导出']")
        export.click()
        page.wait_for_selector(".export-menu")
        page.wait_for_timeout(100)
        assert page.evaluate("() => document.activeElement.getAttribute('role') === 'menuitem'")
        assert "Word" in page.evaluate("() => document.activeElement.innerText")
        page.keyboard.press("ArrowDown")
        assert "HTML" in page.evaluate("() => document.activeElement.innerText")
        page.keyboard.press("End")
        assert "打印" in page.evaluate("() => document.activeElement.innerText")
        page.keyboard.press("Home")
        assert "Word" in page.evaluate("() => document.activeElement.innerText")
        page.screenshot(path=str(args.out / "02-export-keyboard.png"))
        page.keyboard.press("Escape")
        page.wait_for_selector(".export-menu", state="detached", timeout=2000)
        assert page.evaluate("() => document.activeElement.title === '导出'")
        checks.append("导出菜单首项聚焦、方向键循环与焦点返回")

        settings = page.locator("button[title='偏好设置']")
        settings.click()
        page.wait_for_selector(".settings-popover")
        page.wait_for_timeout(100)
        assert page.evaluate("() => !!document.activeElement.closest('.settings-popover')")
        assert page.evaluate("() => document.activeElement.innerText === '浅色'")
        page.keyboard.press("Shift+Tab")
        assert page.evaluate("() => document.activeElement.getAttribute('role') === 'switch'")
        page.keyboard.press("Tab")
        assert page.evaluate("() => document.activeElement.innerText === '浅色'")
        page.screenshot(path=str(args.out / "03-settings-focus.png"))
        page.keyboard.press("Escape")
        page.wait_for_selector(".settings-popover", state="detached", timeout=2000)
        assert page.evaluate("() => document.activeElement.title === '偏好设置'")
        checks.append("设置弹层初始焦点、Tab 环绕与 Escape 返回")

        settings.click()
        page.wait_for_selector(".settings-popover")
        editor = page.locator(".milkdown .ProseMirror")
        editor.click()
        page.wait_for_selector(".settings-popover", state="detached", timeout=2000)
        assert page.evaluate("() => !!document.activeElement.closest('.ProseMirror')")
        checks.append("外部点击不会被旧弹层焦点抢回")

        seeded = browser.new_context(viewport={"width": 1280, "height": 800})
        seed = (
            "window.__PERF_FS = " + json.dumps({"C:/commercial/workspace/note.md": "# Note"}) + ";"
            "window.__PERF_WORKSPACE = 'C:/commercial/workspace';"
            "localStorage.setItem('inkstone.workspace.v1', 'C:/commercial/workspace');"
        )
        seeded.add_init_script(seed + chr(10) + mock)
        sp = seeded.new_page()
        sp.goto(args.url, wait_until="networkidle")
        row = sp.locator(".tree-row").filter(has_text="note.md").first
        row.click(button="right")
        sp.wait_for_selector(".context-menu")
        sp.wait_for_timeout(100)
        assert sp.evaluate("() => document.activeElement.getAttribute('role') === 'menuitem'")
        assert "重命名" in sp.evaluate("() => document.activeElement.innerText")
        sp.keyboard.press("ArrowDown")
        assert "资源管理器" in sp.evaluate("() => document.activeElement.innerText")
        sp.keyboard.press("End")
        assert "回收站" in sp.evaluate("() => document.activeElement.innerText")
        sp.keyboard.press("Home")
        assert "重命名" in sp.evaluate("() => document.activeElement.innerText")
        sp.screenshot(path=str(args.out / "04-context-keyboard.png"))
        sp.keyboard.press("Escape")
        sp.wait_for_selector(".context-menu", state="detached", timeout=2000)
        assert sp.evaluate("() => document.activeElement.getAttribute('role') === 'treeitem'")
        checks.append("文件菜单方向键导航与文稿焦点返回")
        seeded.close()
        context.close()
        browser.close()

    assert not errors, errors
    report = {"passed": len(checks), "failed": 0, "checks": checks, "pageErrors": errors}
    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
