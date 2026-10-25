
"""IME composition regression (synthetic CDP composition + real text insert).

    python inkstone/scripts/perf/typing_ime_e2e.py

Synthetic composition events are a supplement, not a replacement for a real
Windows Pinyin handwriting pass; this checks that composition does not trip
Markdown rules, save corrupt text, or lose the committed characters.
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
WS = "C:/perf/workspace"
DOC = WS + "/ime.md"
BODY = "# IME\n\nA paragraph for composition input.\n"

def active(page):
    return page.evaluate("() => window.__inkTest ? window.__inkTest.activeTab() : null")

def main() -> int:
    failures = []
    passed = 0
    def check(name, ok, detail=""):
        nonlocal passed
        if ok:
            passed += 1
            print("PASS  " + name)
        else:
            failures.append(name)
            print("FAIL  " + name + ("  :: " + detail if detail else ""))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        seed = (
            "window.__PERF_FS = " + json.dumps({DOC: BODY}) + ";"
            "window.__PERF_WORKSPACE = " + json.dumps(WS) + ";"
            "if (!localStorage.getItem('__perf_seeded')) {"
            " localStorage.setItem('inkstone.workspace.v1', " + json.dumps(WS) + ");"
            " localStorage.removeItem('inkstone.drafts.v1');"
            " localStorage.setItem('__perf_seeded','1'); }"
        )
        ctx.add_init_script(seed + "\n" + MOCK)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="load")
        page.wait_for_selector(".app", timeout=30000)
        page.locator(".tree-row").filter(has_text="ime.md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(800)
        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.press("Control+End")
        page.keyboard.press("Enter")
        page.wait_for_timeout(150)

        cdp = ctx.new_cdp_session(page)
        # Start a composition; nothing should be committed or converted yet.
        cdp.send("Input.imeSetComposition", {"text": "nihao", "selectionStart": 5, "selectionEnd": 5})
        page.wait_for_timeout(250)
        mid = active(page) or {}
        dom_text = page.evaluate(
            "() => (document.querySelector('.milkdown .ProseMirror') || {}).innerText || ''")
        check("composition text is visible in the DOM", "nihao" in dom_text, repr(dom_text[-60:]))
        check("composition does not snapshot partial pinyin early",
              "nihao" not in (mid.get("content") or ""), "content tail=" + (mid.get("content") or "")[-60:])

        # Commit the candidate. This is what a real IME does on candidate pick.
        cdp.send("Input.insertText", {"text": "你好"})
        page.wait_for_timeout(700)
        after = active(page) or {}
        content = after.get("content") or ""
        check("committed CJK text present in snapshot", "你好" in content)
        check("pinyin buffer is not duplicated", content.count("nihao") == 0, content[-80:])

        # Markdown-significant characters during a composition must not convert.
        cdp.send("Input.imeSetComposition", {"text": "# ", "selectionStart": 2, "selectionEnd": 2})
        page.wait_for_timeout(120)
        cdp.send("Input.insertText", {"text": "# "})
        page.wait_for_timeout(600)
        conversion = page.evaluate(
            "() => { const ps=[...document.querySelectorAll('.milkdown p')];"
            " const last=ps[ps.length-1]; return last ? last.innerText : ''; }")
        check("composition-inserted '# ' stays literal", "#" in conversion, repr(conversion))

        # Saving mid-composition must not persist the provisional pinyin.
        cdp.send("Input.imeSetComposition", {"text": "buzhidao", "selectionStart": 8, "selectionEnd": 8})
        page.wait_for_timeout(120)
        page.keyboard.press("Control+s")
        page.wait_for_timeout(800)
        disk_mid = page.evaluate(
            "() => (window.__perfFs && window.__perfFs.files[%s]) || ''" % json.dumps(DOC))
        check("save during composition does not persist pinyin", "buzhidao" not in disk_mid,
              "disk tail=" + disk_mid[-60:])
        cdp.send("Input.insertText", {"text": "不知道"})
        page.wait_for_timeout(500)

        # Undo after IME commit keeps text coherent.
        page.keyboard.press("Control+z")
        page.wait_for_timeout(400)
        check("undo after IME commit keeps a valid snapshot",
              isinstance((active(page) or {}).get("content"), str))

        # Save and make sure the IME text lands on disk.
        page.keyboard.press("Control+s")
        deadline = time.time() + 5
        saved = ""
        while time.time() < deadline:
            saved = page.evaluate(
                "() => (window.__perfFs && window.__perfFs.files[%s]) || ''" % json.dumps(DOC))
            if "你好" in saved:
                break
            time.sleep(0.1)
        check("IME text saved to disk", "你好" in saved, "tail=" + saved[-60:])
        check("no page errors", not errors, repr(errors[:2]))
        browser.close()

    print()
    print("SUMMARY: %d passed, %d failed" % (passed, len(failures)))
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
