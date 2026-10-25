
"""30-minute dual-instance soak with repeated mode switches.

Verifies that keeping both editors alive does not leak instances/listeners,
and that every switch preserves the newest text.

    python inkstone/scripts/perf/tauri_soak_dual.py --minutes 30
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
WS = ROOT / "analysis" / "perf-tauri" / "workspace"
WS_SLASH = str(WS).replace("\\", "/")
DOC = WS / "T3.md"
OUT = ROOT / "analysis" / "perf" / "tauri-soak-dual.json"
# The rich editor renders each code fence with its own CodeMirror instance, so
# ".cm-content" is ambiguous. Always target the app's source editor explicitly.
SOURCE = ".source-editor-shell .cm-content"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=30.0)
    args = parser.parse_args()
    original = DOC.read_text(encoding="utf-8")
    samples = []
    failures = []
    started = time.time()
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
            page = browser.contexts[0].pages[0]
            page.set_viewport_size({"width": 1440, "height": 900})
            page.evaluate(
                "(ws) => { localStorage.clear(); localStorage.setItem('inkstone.workspace.v1', ws); }",
                WS_SLASH,
            )
            page.reload(wait_until="load")
            page.wait_for_selector(".tree-row", timeout=30000)
            page.locator(".tree-row").filter(has_text="T3.md").first.click()
            page.wait_for_selector(".milkdown .ProseMirror", timeout=60000)
            page.wait_for_timeout(1500)
            print("soak start", datetime.now().isoformat(timespec="seconds"), flush=True)
            last_sample = 0.0
            round_index = 0
            while time.time() - started < args.minutes * 60:
                round_index += 1
                marker = "M%d" % round_index
                page.locator(".mode-switch button").nth(0).click()
                page.wait_for_selector(".milkdown .ProseMirror", state="visible", timeout=120000)
                page.wait_for_timeout(150)
                page.locator(".milkdown .ProseMirror").click()
                page.keyboard.press("Control+End")
                page.keyboard.type(" " + marker, delay=12)
                page.wait_for_timeout(900)
                page.locator(".mode-switch button").nth(1).click()
                page.wait_for_selector(SOURCE, state="visible", timeout=120000)
                page.wait_for_timeout(250)
                tab = page.evaluate("() => window.__inkTest ? window.__inkTest.activeTab() : null")
                content = (tab or {}).get("content") or ""
                if marker not in content:
                    failures.append({"round": round_index, "phase": "rich->source", "len": len(content)})
                source_marker = "S%d" % round_index
                page.locator(SOURCE).click()
                page.keyboard.press("Control+End")
                page.keyboard.type(" " + source_marker, delay=12)
                page.wait_for_timeout(300)
                page.locator(".mode-switch button").nth(0).click()
                page.wait_for_selector(".milkdown .ProseMirror", state="visible", timeout=120000)
                page.wait_for_timeout(250)
                tab = page.evaluate("() => window.__inkTest ? window.__inkTest.activeTab() : null")
                content = (tab or {}).get("content") or ""
                if source_marker not in content:
                    failures.append({"round": round_index, "phase": "source->rich", "len": len(content)})
                page.wait_for_timeout(1500)

                elapsed = time.time() - started
                if last_sample == 0 or elapsed - last_sample >= 60:
                    last_sample = elapsed
                    sample = page.evaluate(
                        "() => ({ heap: performance.memory ? performance.memory.usedJSHeapSize : 0,"
                        " nodes: document.getElementsByTagName('*').length,"
                        " milkdown: document.querySelectorAll('.milkdown').length,"
                        " sourceEditors: document.querySelectorAll('.source-editor-shell .cm-editor').length,"
                        " codeBlockEditors: document.querySelectorAll('.milkdown .cm-editor').length,"
                        " layers: [...document.querySelectorAll('.editor-layer')].map(l => l.hidden ? 0 : 1) })")
                    sample.update({"minute": round(elapsed / 60, 2), "round": round_index})
                    samples.append(sample)
                    print(json.dumps(sample), flush=True)
            browser.close()
    finally:
        DOC.write_text(original, encoding="utf-8")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"minutes": args.minutes, "samples": samples, "failures": failures}, indent=2), encoding="utf-8")
    if len(samples) >= 2:
        first, last = samples[0]["heap"], samples[-1]["heap"]
        growth = (last - first) / first * 100 if first else 0
        print("heap growth: %.1f%% (%d -> %d), switches: %d, failures: %d"
              % (growth, first, last, samples[-1]["round"], len(failures)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
