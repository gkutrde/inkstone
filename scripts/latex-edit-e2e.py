from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOC_NAME = "LaTeX 编辑回归.md"
INITIAL_MARKDOWN = "Inline $E=mc^2$ end.\n\n$$\nx=1\n$$\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 Inkstone 行内与块级 LaTeX 可编辑并正确保存")
    parser.add_argument("--url", default="http://127.0.0.1:1420")
    parser.add_argument("--cdp", action="store_true", help="连接已开启调试端口的真实 WebView2")
    parser.add_argument("--port", type=int, default=9237)
    parser.add_argument("--label", default="current")
    args = parser.parse_args()

    out = ROOT.parent / "analysis" / "latex-edit"
    workspace = out / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    document = workspace / DOC_NAME
    document.write_text(INITIAL_MARKDOWN, encoding="utf-8")
    document_path = str(document) if args.cdp else f"C:/latex-edit/{DOC_NAME}"
    mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
    seed = (
        "window.__PERF_FS = " + json.dumps({document_path: INITIAL_MARKDOWN}) + ";"
        "window.__PERF_WORKSPACE = 'C:/latex-edit';"
        "window.__PERF_DIALOG = null;"
        "localStorage.setItem('inkstone.workspace.v1', 'C:/latex-edit');"
        "localStorage.removeItem('inkstone.drafts.v1');"
    )
    page_errors: list[str] = []
    console_errors: list[str] = []

    with sync_playwright() as playwright:
        if args.cdp:
            endpoint = f"http://127.0.0.1:{args.port}"
            deadline = time.monotonic() + 30
            while True:
                try:
                    with urllib.request.urlopen(endpoint + "/json/version", timeout=1) as response:
                        json.loads(response.read().decode("utf-8"))
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.25)
            browser = playwright.chromium.connect_over_cdp(endpoint)
            page = browser.contexts[0].pages[0]
        else:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 960})
            context.add_init_script(seed + chr(10) + mock)
            page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        if args.cdp:
            page.evaluate("workspace => localStorage.setItem('inkstone.workspace.v1', workspace)", str(workspace))
            page.reload(wait_until="networkidle")
        else:
            page.goto(args.url, wait_until="networkidle")
        page.locator(".tree-row").filter(has_text=DOC_NAME).first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(1000)
        page.screenshot(path=str(out / f"{args.label}-before.png"))

        inline = page.locator('.milkdown .ProseMirror span[data-type="math_inline"]').first
        inline.click()
        tooltip = page.locator(".milkdown-latex-inline-edit")
        page.wait_for_selector('.milkdown-latex-inline-edit[data-show="true"]', timeout=5000)
        inline_editor = tooltip.locator(".ProseMirror")
        inline_editor.wait_for(state="visible", timeout=5000)
        inline_editor.click()
        page.keyboard.press("Control+A")
        page.keyboard.type("y=x+1")
        page.wait_for_timeout(300)
        inline_value_during_edit = inline.get_attribute("data-value")
        page.keyboard.press("Control+S")
        page.wait_for_timeout(800)
        if args.cdp:
            saved_during_edit = document.read_text(encoding="utf-8")
        else:
            files = page.evaluate("() => window.__perfFs ? window.__perfFs.files : {}")
            saved_during_edit = files.get(document_path, "")

        # 不额外按 Enter：直接点击别处也必须保留行内公式修改。
        block = page.locator(".milkdown-code-block").filter(has_text="LaTeX").first
        block_editor = block.locator(".cm-content")
        block_editor.click()
        page.wait_for_timeout(300)
        inline_value = inline.get_attribute("data-value")
        page.keyboard.press("Control+A")
        page.keyboard.type("z=3")
        page.wait_for_timeout(1000)
        page.screenshot(path=str(out / f"{args.label}-after.png"))

        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".source-editor-shell .cm-editor", timeout=15000)
        page.keyboard.press("Control+S")
        page.wait_for_timeout(800)
        if args.cdp:
            saved = document.read_text(encoding="utf-8")
        else:
            files = page.evaluate("() => window.__perfFs ? window.__perfFs.files : {}")
            saved = files.get(document_path, "")
        (out / f"{args.label}-roundtrip.md").write_text(saved, encoding="utf-8")
        result = {
            "inlineValueDuringEdit": inline_value_during_edit,
            "savedDuringEdit": saved_during_edit,
            "inlineValue": inline_value,
            "saved": saved,
            "pageErrors": page_errors,
            "consoleErrors": console_errors,
        }
        (out / f"{args.label}-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        browser.close()

    assert inline_value_during_edit == "y=x+1", "输入时行内公式节点未同步更新"
    assert "$y=x+1$" in saved_during_edit, "编辑框内直接保存丢失了行内公式修改"
    assert inline_value == "y=x+1", f"行内公式未更新：{inline_value!r}"
    assert "$y=x+1$" in saved, "行内公式修改未保存到 Markdown"
    assert "z=3" in saved and "x=1" not in saved, "块级公式修改未保存到 Markdown"
    assert not page_errors, f"页面异常：{page_errors}"
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
