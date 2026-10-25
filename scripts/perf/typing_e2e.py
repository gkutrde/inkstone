
"""End-to-end regression for the typing pipeline (M1/M2/M4).

Runs the production build against the in-memory Tauri mock so that save,
autosave, drafts, tab switching and mode switching can be asserted without
launching the desktop shell.

    python inkstone/scripts/perf/typing_e2e.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[2]
MOCK = (SCRIPT_DIR / "tauri_mock.js").read_text(encoding="utf-8")
URL = "http://127.0.0.1:4173"
WORKSPACE = "C:/perf/workspace"
ALPHA = WORKSPACE + "/alpha.md"
BETA = WORKSPACE + "/beta.md"

ALPHA_BODY = "# Alpha\n\n" + "\n\n".join(
    "Paragraph %d: calm prose for the alpha document." % i for i in range(1, 40)
)
BETA_BODY = "# Beta\n\nA second document for tab switching.\n"


class Results:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes = 0

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        if ok:
            self.passes += 1
            print("PASS  " + name)
        else:
            self.failures.append(name)
            print("FAIL  " + name + ("  :: " + detail if detail else ""))

    def eq(self, name: str, actual, expected) -> None:
        self.check(name, actual == expected, "actual=%r expected=%r" % (actual, expected))


def build_init_script(docs: dict[str, str]) -> str:
    seed = (
        "window.__PERF_FS = " + json.dumps(docs) + ";"
        "window.__PERF_WORKSPACE = " + json.dumps(WORKSPACE) + ";"
        "window.__PERF_DIALOG = " + json.dumps(WORKSPACE + "/untitled.md") + ";"
        "if (!localStorage.getItem('__perf_seeded')) {"
        " localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WORKSPACE) + ");"
        " localStorage.removeItem('inkstone.drafts.v1');"
        " localStorage.setItem('__perf_seeded', '1');"
        " }"
    )
    return seed + "\n" + MOCK


def active(page) -> dict | None:
    return page.evaluate("() => window.__inkTest ? window.__inkTest.activeTab() : null")


def disks(page) -> dict:
    return page.evaluate("() => window.__perfFs ? window.__perfFs.files : {}")


def wait_disk(page, path: str, needle: str, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        content = (disks(page) or {}).get(path, "")
        if needle in content:
            return True
        time.sleep(0.1)
    return False


def wait_active_content(page, needle: str, timeout: float = 4.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        tab = active(page)
        if tab and needle in (tab.get("content") or ""):
            return True
        time.sleep(0.1)
    return False


def click_editor_end(page) -> None:
    page.locator(".milkdown .ProseMirror").click()
    page.keyboard.press("Control+End")
    page.wait_for_timeout(120)


def type_text(page, text: str, delay: int = 20) -> None:
    page.keyboard.type(text, delay=delay)


def main() -> int:
    r = Results()
    errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_init_script(build_init_script({ALPHA: ALPHA_BODY, BETA: BETA_BODY}))
        page = ctx.new_page()
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(URL, wait_until="load")
        page.wait_for_selector(".app", timeout=30000)
        page.wait_for_selector(".tree-row", timeout=30000)

        # 1. open
        page.locator(".tree-row").filter(has_text="alpha.md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(700)
        r.eq("open: active path", (active(page) or {}).get("path"), ALPHA)

        # 2. type + dirty within the first 600 ms + explicit save writes newest text
        click_editor_end(page)
        type_text(page, " SAVE-MARK-1")
        page.wait_for_timeout(450)
        r.check("dirty state before save", "已保存" not in page.locator(".save-state").inner_text())
        page.keyboard.press("Control+s")
        r.check("explicit save writes newest text", wait_disk(page, ALPHA, "SAVE-MARK-1"))
        page.wait_for_timeout(300)
        r.check("save label returns to 已保存", "已保存" in page.locator(".save-state").inner_text())
        r.check("saved content carries marker", "SAVE-MARK-1" in ((active(page) or {}).get("content") or ""))

        # 3. autosave
        click_editor_end(page)
        type_text(page, " AUTO-MARK-2")
        r.check("autosave writes without Ctrl+S", wait_disk(page, ALPHA, "AUTO-MARK-2", timeout=6.0))

        # 3b. Ctrl+/ toggles source/rendered; F1 opens shortcut help
        page.keyboard.press("Control+/")
        page.wait_for_selector(".source-editor-shell .cm-content", state="visible", timeout=20000)
        page.wait_for_timeout(250)
        r.eq("Ctrl+/ enters source mode", (active(page) or {}).get("mode"), "source")
        page.keyboard.press("Control+/")
        page.wait_for_selector(".milkdown .ProseMirror", state="visible", timeout=30000)
        page.wait_for_timeout(350)
        r.eq("Ctrl+/ returns to rich mode", (active(page) or {}).get("mode"), "rich")
        page.keyboard.press("F1")
        page.wait_for_selector(".shortcut-dialog", timeout=5000)
        r.check("F1 opens shortcut help", True)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        # 4. rich -> source keeps newest text
        page.keyboard.press("Control+e")
        page.wait_for_selector(".source-editor-shell .cm-content", timeout=30000)
        page.wait_for_timeout(200)
        r.eq("mode switch: source mode", (active(page) or {}).get("mode"), "source")
        r.check("mode switch: snapshot carries marker", "AUTO-MARK-2" in ((active(page) or {}).get("content") or ""))

        # 5. edit in source, switch back
        page.locator(".source-editor-shell .cm-content").click()
        page.keyboard.press("Control+End")
        page.wait_for_timeout(150)
        type_text(page, " SOURCE-MARK-3")
        page.wait_for_timeout(400)
        page.keyboard.press("Control+e")
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(700)
        r.check("source edits reach rich snapshot", "SOURCE-MARK-3" in ((active(page) or {}).get("content") or ""))
        click_editor_end(page)
        r.check("source edits visible in rich DOM", "SOURCE-MARK-3" in page.evaluate(
            "() => document.querySelector('.milkdown .ProseMirror').innerText"))

        # 6. tab switch flushes the last keystrokes
        page.locator(".tree-row").filter(has_text="beta.md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(600)
        r.eq("tab switch: active path", (active(page) or {}).get("path"), BETA)
        click_editor_end(page)
        type_text(page, " BETA-FAST-SWITCH")
        page.wait_for_timeout(60)
        page.locator(".tree-row").filter(has_text="alpha.md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(500)
        page.locator(".tree-row").filter(has_text="beta.md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(500)
        beta_content = (active(page) or {}).get("content") or ""
        r.check("tab switch flushes last keystrokes", "BETA-FAST-SWITCH" in beta_content,
                "content tail=" + beta_content[-80:].replace("\n", " "))

        # 7. undo / redo
        click_editor_end(page)
        type_text(page, "UNDO-TOKEN")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)
        r.check("undo removes typed token", "UNDO-TOKEN" not in ((active(page) or {}).get("content") or ""))
        page.keyboard.press("Control+Shift+z")
        page.wait_for_timeout(400)
        r.check("redo restores typed token", "UNDO-TOKEN" in ((active(page) or {}).get("content") or ""))

        # 8. long burst: no duplication, length grows by the typed count
        before = len((active(page) or {}).get("content") or "")
        payload = "".join(chr(ord("a") + (i % 26)) for i in range(400))
        before_content = (active(page) or {}).get("content") or ""
        type_text(page, payload, delay=0)
        page.wait_for_timeout(900)
        after_content = (active(page) or {}).get("content") or ""
        r.check("long burst not duplicated", after_content.count(payload) == 1)
        r.check("long burst length grows", len(after_content) >= before + 380,
                "before=%d after=%d" % (before, len(after_content)))

        # 9. markdown shortcut "# " turns the current block into a heading
        click_editor_end(page)
        page.keyboard.press("Enter")
        page.keyboard.type("#", delay=40)
        page.keyboard.press("Space")
        page.wait_for_timeout(120)
        type_text(page, "Shortcut Heading", delay=20)
        page.wait_for_timeout(700)
        h1 = page.evaluate("() => { const hs=[...document.querySelectorAll('.milkdown h1')];"
                           " return hs.length ? hs[hs.length-1].innerText : null; }")
        r.eq("markdown shortcut renders h1", h1, "Shortcut Heading")
        r.check("markdown shortcut snapshot has heading", "# Shortcut Heading" in ((active(page) or {}).get("content") or ""))

        # 9b. closing immediately after a keystroke must still warn (200 ms window)
        page.evaluate(
            "() => { window.__confirmCalls = 0;"
            " const original = window.__TAURI_INTERNALS__.invoke;"
            " window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => {"
            "   if (cmd === 'plugin:dialog|message') window.__confirmCalls += 1;"
            "   return original(cmd, args, opts); }; }")
        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.press("Control+End")
        page.keyboard.type("Q", delay=0)
        page.locator(".tab-item.is-active .tab-close").click()
        page.wait_for_timeout(500)
        confirm_calls = page.evaluate("() => window.__confirmCalls || 0")
        r.check("close right after typing asks for confirmation", confirm_calls >= 1,
                "confirm_calls=%r" % confirm_calls)

        # 10. drafts: new untitled doc survives reload
        page.keyboard.press("Control+n")
        page.wait_for_timeout(800)
        active_editor = page.locator(".milkdown .ProseMirror").last
        active_editor.click()
        type_text(page, "DRAFT-MARK-4")
        page.wait_for_timeout(1400)
        draft_tab = active(page) or {}
        r.check("draft tab is dirty", bool(draft_tab.get("dirty")), repr(draft_tab))
        page.reload(wait_until="load")
        page.wait_for_selector(".tab-item", timeout=30000)
        page.wait_for_timeout(900)
        restored = page.evaluate("() => window.__inkTest ? window.__inkTest.tabs() : []")
        has_draft = any((t.get("name") or "").startswith("未命名") for t in restored)
        r.check("draft tab restored after reload", has_draft, repr(restored)[:300])
        if has_draft:
            page.locator(".tab-item").filter(has_text="未命名").first.click()
            page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
            page.wait_for_timeout(700)
            r.check("restored draft keeps text", "DRAFT-MARK-4" in ((active(page) or {}).get("content") or ""))

        r.check("no page errors", not errors, repr(errors[:3]))
        browser.close()

    print()
    print("SUMMARY: %d passed, %d failed" % (r.passes, len(r.failures)))
    if r.failures:
        print("FAILED:", ", ".join(r.failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
