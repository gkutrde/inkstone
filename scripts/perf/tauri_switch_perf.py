
"""Real desktop mode-switch measurement for the dual-instance implementation.

Requires the release app running with CDP 9222 and built with
VITE_EDITOR_METRICS=1.

    python inkstone/scripts/perf/tauri_switch_perf.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
WS = ROOT / "analysis" / "perf-tauri" / "workspace"
WS_SLASH = str(WS).replace("\\", "/")
CDP = "http://127.0.0.1:9222"
OUT = ROOT / "analysis" / "perf" / "tauri-switch.json"
SOURCE = ".source-editor-shell .cm-content"
KEEP = ("mode_switch_ready", "mode_switch_chunk_ready", "mode_switch_commit",
        "mode_switch_paint", "markdown_flush", "mode_sync_source", "mode_sync_rich")


def snap(page):
    return page.evaluate("() => window.__inkMetrics ? window.__inkMetrics.snapshot().samples : []")


def diff(before, after):
    counts = {}
    for sample in before:
        counts[sample["name"]] = counts.get(sample["name"], 0) + 1
    seen, out = {}, {}
    for sample in after:
        name = sample["name"]
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > counts.get(name, 0) and name in KEEP:
            out.setdefault(name, []).append(sample["ms"])
    return out


def open_doc(page, name):
    page.locator(".tree-row").filter(has_text=name).first.click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=60000)
    page.wait_for_timeout(1500)
    page.locator(".milkdown .ProseMirror").click()
    page.keyboard.press("Control+End")
    page.wait_for_timeout(150)


def switch(page, mode_index, selector):
    before = snap(page)
    t0 = time.time()
    page.locator(".mode-switch button").nth(mode_index).click()
    page.wait_for_selector(selector, state="visible", timeout=120000)
    page.wait_for_timeout(150)
    return {"wall_ms": round((time.time() - t0) * 1000), "metrics": diff(before, snap(page))}


def main() -> int:
    report = {"env": {}, "models": {}}
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        page = browser.contexts[0].pages[0]
        page.set_viewport_size({"width": 1440, "height": 900})
        page.evaluate(
            "(ws) => { localStorage.clear(); localStorage.setItem('inkstone.workspace.v1', ws); }",
            WS_SLASH,
        )
        page.reload(wait_until="load")
        page.wait_for_selector(".tree-row", timeout=30000)
        page.wait_for_timeout(1200)
        report["env"] = page.evaluate("() => ({ ua: navigator.userAgent, metrics: !!window.__inkMetrics })")
        print("ENV:", json.dumps(report["env"]))

        for model in ("T3", "T4"):
            path = WS / (model + ".md")
            original = path.read_text(encoding="utf-8")
            entry = {"bytes": len(original.encode()), "steps": []}
            try:
                open_doc(page, model + ".md")
                entry["steps"].append({"step": "rich->source cold", **switch(page, 1, SOURCE)})
                entry["steps"].append({"step": "source->rich hot", **switch(page, 0, ".milkdown .ProseMirror")})
                entry["steps"].append({"step": "rich->source hot", **switch(page, 1, SOURCE)})
                entry["steps"].append({"step": "source->rich hot", **switch(page, 0, ".milkdown .ProseMirror")})

                # edited path: rich -> source (flush + source sync)
                page.locator(".milkdown .ProseMirror").click()
                page.keyboard.press("Control+End")
                page.keyboard.type(" RICHMARK", delay=10)
                entry["steps"].append({"step": "rich(edited)->source", **switch(page, 1, SOURCE)})
                # edited path: source -> rich (rich sync)
                page.locator(SOURCE).click()
                page.keyboard.press("Control+End")
                page.keyboard.type(" SRCMARK", delay=10)
                page.wait_for_timeout(150)
                entry["steps"].append({"step": "source(edited)->rich", **switch(page, 0, ".milkdown .ProseMirror")})

                tab = page.evaluate("() => window.__inkTest ? window.__inkTest.activeTab() : null")
                content = (tab or {}).get("content") or ""
                entry["content_ok"] = "RICHMARK" in content and "SRCMARK" in content
                entry["instances"] = page.evaluate(
                    "() => ({ milkdown: document.querySelectorAll('.milkdown').length,"
                    " sourceEditors: document.querySelectorAll('.source-editor-shell .cm-editor').length,"
                    " codeBlockEditors: document.querySelectorAll('.milkdown .cm-editor').length })")
                page.wait_for_timeout(300)
                entry["memory_mb"] = round((page.evaluate(
                    "() => performance.memory ? performance.memory.usedJSHeapSize : 0")) / 1e6, 1)
            finally:
                path.write_text(original, encoding="utf-8")
            report["models"][model] = entry
            print(model, "content_ok=", entry.get("content_ok"), "instances=", entry.get("instances"),
                  "memory_mb=", entry.get("memory_mb"))
        browser.close()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
