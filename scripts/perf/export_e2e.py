
"""Export regression through the real UI (DOCX / HTML / Markdown).

Runs the production build against the in-memory Tauri mock and asserts that an
export taken immediately after typing contains the newest text (the old
implementation could export the last debounced snapshot).

    python inkstone/scripts/perf/export_e2e.py
"""
from __future__ import annotations

import io
import json
import sys
import time
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
MOCK = (ROOT / "inkstone" / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
URL = "http://127.0.0.1:4173"
WS = "C:/perf/workspace"
DOC = WS + "/export.md"
OUT = "C:/perf/out"
BODY = "# Export\n\nBase paragraph before the live marker.\n"


def wait_export(page, path, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = page.evaluate("(p) => (window.__perfFs && window.__perfFs.exports[p]) || null", path)
        if record:
            return record
        time.sleep(0.2)
    return None


def main() -> int:
    failures, passed = [], 0
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
            "window.__PERF_DIALOG = " + json.dumps(OUT + "/export.docx") + ";"
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
        page.locator(".tree-row").filter(has_text="export.md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        page.wait_for_timeout(800)

        marker = "LIVEMARKER42"
        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.press("Control+End")
        page.keyboard.type(" " + marker, delay=8)
        # No wait: the export click happens inside the 200 ms debounce window.

        # --- DOCX -----------------------------------------------------------
        page.evaluate("(p) => { window.__PERF_DIALOG = p; }", OUT + "/export.docx")
        page.locator("button[title='导出']").click()
        page.get_by_role("menuitem", name="Word 文档").click()
        record = wait_export(page, OUT + "/export.docx")
        ok = False
        if record and record.get("bytes"):
            raw = bytes(record["bytes"])
            try:
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    xml = archive.read("word/document.xml").decode("utf-8", "ignore")
                    ok = marker in xml
            except Exception as exc:
                print("docx error:", exc)
        check("DOCX export contains text typed inside the debounce window", ok)

        # --- HTML -----------------------------------------------------------
        page.evaluate("(p) => { window.__PERF_DIALOG = p; }", OUT + "/export.html")
        page.locator("button[title='导出']").click()
        page.get_by_role("menuitem", name="HTML 网页").click()
        record = wait_export(page, OUT + "/export.html")
        check("HTML export contains the newest text",
              bool(record and marker in (record.get("text") or "")))

        # --- Markdown -------------------------------------------------------
        page.evaluate("(p) => { window.__PERF_DIALOG = p; }", OUT + "/export.md")
        page.locator("button[title='导出']").click()
        page.get_by_role("menuitem", name="Markdown 副本").click()
        record = wait_export(page, OUT + "/export.md")
        check("Markdown export contains the newest text",
              bool(record and marker in (record.get("text") or "")))
        check("no page errors", not errors, repr(errors[:2]))
        browser.close()

    print()
    print("SUMMARY: %d passed, %d failed" % (passed, len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
