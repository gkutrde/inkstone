
"""Memory / instance soak on the real desktop shell.

Types in a loop against a 250 KB document and samples JS heap every minute.
Run against the clean release build over CDP 9222.

    python inkstone/scripts/perf/tauri_soak.py --minutes 30
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
OUT = ROOT / "analysis" / "perf" / "tauri-soak.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=30.0)
    args = parser.parse_args()
    original = DOC.read_text(encoding="utf-8")
    samples = []
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
            page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
            page.wait_for_timeout(1500)
            print("soak start", datetime.now().isoformat(timespec="seconds"))
            last_sample = 0.0
            burst = 0
            while time.time() - started < args.minutes * 60:
                page.locator(".milkdown .ProseMirror").click()
                page.keyboard.press("Control+End")
                burst += 1
                payload = "".join(chr(ord("a") + ((burst + i) % 26)) for i in range(12))
                page.keyboard.type(" " + payload, delay=15)
                page.wait_for_timeout(2500)
                elapsed = time.time() - started
                if elapsed - last_sample >= 60 or last_sample == 0:
                    last_sample = elapsed
                    sample = page.evaluate(
                        "() => ({ heap: performance.memory ? performance.memory.usedJSHeapSize : 0,"
                        " nodes: document.getElementsByTagName('*').length,"
                        " editors: document.querySelectorAll('.milkdown .ProseMirror').length,"
                        " cm: document.querySelectorAll('.cm-editor').length })")
                    sample.update({"minute": round(elapsed / 60, 2), "bursts": burst})
                    samples.append(sample)
                    print(json.dumps(sample))
            browser.close()
    finally:
        DOC.write_text(original, encoding="utf-8")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"minutes": args.minutes, "samples": samples}, indent=2), encoding="utf-8")
    if len(samples) >= 2:
        first, last = samples[0]["heap"], samples[-1]["heap"]
        growth = (last - first) / first * 100 if first else 0
        print("heap growth: %.1f%%  (%d -> %d)" % (growth, first, last))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
