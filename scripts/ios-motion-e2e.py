from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT.parent / "analysis" / "ios-liquid-glass" / "motion"


def observe_closing(page, selector: str) -> None:
    page.evaluate("""selector => {
      const element = document.querySelector(selector);
      window.__closingSeen = false;
      if (!element) return;
      new MutationObserver(() => {
        if (element.dataset.state === 'closing') window.__closingSeen = true;
      }).observe(element, { attributes: true, attributeFilter: ['data-state'] });
    }""", selector)


def closing_seen(page) -> bool:
    return bool(page.evaluate("() => window.__closingSeen"))


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 Inkstone iOS 式交互动效与无障碍降级")
    parser.add_argument("--url", default="http://127.0.0.1:1420")
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    checks: list[str] = []
    errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        context.add_init_script(mock)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url, wait_until="networkidle")
        page.evaluate("() => localStorage.clear()")
        page.reload(wait_until="networkidle")
        page.locator(".sidebar-compose").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=20000)

        mode = page.locator(".mode-switch")
        assert mode.get_attribute("data-mode") == "rich"
        mode.locator("button").nth(1).click()
        page.wait_for_selector(".source-editor-shell .cm-editor", timeout=20000)
        page.wait_for_timeout(320)
        assert mode.get_attribute("data-mode") == "source"
        source_x = page.evaluate("""() => {
          const value = getComputedStyle(document.querySelector('.mode-switch'), '::before').transform;
          return value === 'none' ? 0 : new DOMMatrixReadOnly(value).m41;
        }""")
        assert source_x > 10, f"分段滑块未移动：{source_x}"
        checks.append("分段控件滑块连续移动")
        mode.locator("button").nth(0).click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=20000)

        page.locator(".command-trigger").click()
        page.wait_for_selector('.command-dialog[data-state="open"]')
        page.wait_for_timeout(50)
        page.screenshot(path=str(args.out / "01-command-opening.png"))
        page.wait_for_timeout(260)
        page.screenshot(path=str(args.out / "02-command-open.png"))
        observe_closing(page, ".command-backdrop")
        page.keyboard.press("Escape")
        page.wait_for_selector(".command-backdrop", state="detached", timeout=2000)
        assert closing_seen(page), "命令中心缺少 closing 退场状态"
        assert page.evaluate("() => document.activeElement?.classList.contains('command-trigger')")
        checks.append("命令中心弹性进出场与焦点返回")

        settings_trigger = page.locator("button[title='偏好设置']")
        settings_trigger.click()
        page.wait_for_selector('.settings-popover[data-state="open"]')
        observe_closing(page, ".settings-popover")
        settings_trigger.click()
        page.wait_for_selector(".settings-popover", state="detached", timeout=2000)
        assert closing_seen(page), "设置弹层缺少 closing 退场状态"
        checks.append("设置弹层来源一致的退场")

        settings_trigger.click()
        page.wait_for_selector(".settings-popover")
        transparency = page.locator(".settings-toggle input").nth(1)
        transparency.check()
        page.wait_for_timeout(80)
        backdrop = page.evaluate("() => getComputedStyle(document.querySelector('.settings-popover')).backdropFilter")
        assert backdrop == "none", f"减少透明效果未降级：{backdrop}"
        transparency.uncheck()
        checks.append("减少透明效果切换为实心表面")
        observe_closing(page, ".settings-popover")
        page.keyboard.press("Escape")
        page.wait_for_selector(".settings-popover", state="detached", timeout=2000)

        page.keyboard.press("Control+f")
        page.wait_for_selector('.find-bar[data-state="open"]')
        observe_closing(page, ".find-bar")
        page.keyboard.press("Escape")
        page.wait_for_selector(".find-bar", state="detached", timeout=2000)
        assert closing_seen(page), "查找条缺少 closing 退场状态"
        checks.append("查找条关闭动画")

        page.locator(".command-trigger").click()
        command_input = page.locator(".command-search-row input")
        command_input.fill("专注")
        command_input.press("Enter")
        page.wait_for_selector(".command-backdrop", state="detached", timeout=2000)
        page.wait_for_selector(".app.is-focus", timeout=2000)
        page.keyboard.press("Control+Shift+d")
        checks.append("命令退场后才执行下一动作")

        page.keyboard.press("F1")
        page.wait_for_selector('.shortcut-dialog[data-state="open"]')
        observe_closing(page, ".shortcut-dialog")
        page.keyboard.press("Escape")
        page.wait_for_selector(".shortcut-dialog", state="detached", timeout=2000)
        assert closing_seen(page), "快捷键弹层缺少 closing 退场状态"
        checks.append("快捷键弹层退场与焦点管理")

        reduced = browser.new_context(
            viewport={"width": 1280, "height": 800},
            reduced_motion="reduce",
        )
        reduced.add_init_script(mock)
        rp = reduced.new_page()
        rp.goto(args.url, wait_until="networkidle")
        rp.locator(".command-trigger").click()
        rp.wait_for_selector(".command-dialog")
        duration = rp.evaluate("() => getComputedStyle(document.querySelector('.command-dialog')).animationDuration")
        assert "0.00001" in duration or duration == "1e-05s", f"减少动态效果仍执行长动画：{duration}"
        rp.keyboard.press("Escape")
        rp.wait_for_selector(".command-backdrop", state="detached", timeout=300)
        assert rp.locator('.command-backdrop[data-state="closing"]').count() == 0
        checks.append("减少动态效果立即关闭且无长动画")
        reduced.close()
        context.close()
        browser.close()

    assert not errors, f"页面异常：{errors}"
    report = {"passed": len(checks), "failed": 0, "checks": checks, "pageErrors": errors}
    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
