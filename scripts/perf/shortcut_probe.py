
"""Measure the visible frame cost of the '# + space' heading shortcut."""
from __future__ import annotations

import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
MOCK = (ROOT / "inkstone/scripts/perf/tauri_mock.js").read_text(encoding="utf-8")
sys.path.insert(0, str(ROOT / "inkstone/scripts/perf"))
import fixtures
from bench import build_init_script, open_document, JS_SET_WORKSPACE

URL = "http://127.0.0.1:4173"
WS = "C:/perf/workspace"
results = {}

for model in ("T1", "T3"):
    doc_path = WS + "/" + model + ".md"
    content = fixtures.generate(model)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_init_script(build_init_script(MOCK, doc_path, content, WS))
        page = ctx.new_page()
        page.goto(URL, wait_until="load")
        page.wait_for_selector(".app", timeout=30000)
        page.evaluate(JS_SET_WORKSPACE, WS)
        page.reload(wait_until="load")
        page.wait_for_selector(".app", timeout=30000)
        open_document(page, doc_path)
        page.wait_for_timeout(1200)
        trials = []
        for trial in range(3):
            before = page.evaluate("() => document.querySelectorAll('.milkdown h1').length")
            target = page.locator(".milkdown .ProseMirror > p").nth(2)
            target.click()
            page.keyboard.press("Home")
            page.keyboard.press("Enter")
            page.wait_for_timeout(120)
            page.evaluate("() => window.__inkMetrics.clear()")
            page.keyboard.type("#", delay=0)
            page.keyboard.press("Space")
            page.keyboard.type("Shortcut", delay=0)
            page.wait_for_timeout(450)
            after = page.evaluate("() => document.querySelectorAll('.milkdown h1').length")
            snap = page.evaluate("() => window.__inkMetrics.snapshot()")
            frames = [s["ms"] for s in snap["samples"] if s["name"] == "input_to_frame"]
            events = [s["ms"] for s in snap["samples"] if s["name"] == "event_input"]
            converted = page.evaluate(
                "() => [...document.querySelectorAll('.milkdown h1')].some(h => h.innerText.includes('Shortcut'))")
            trials.append({"converted": converted, "h1_delta": after - before,
                           "frames": frames, "events": events})
        results[model] = trials
        browser.close()

print(json.dumps(results))
