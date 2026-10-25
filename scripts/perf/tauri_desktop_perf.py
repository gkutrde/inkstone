
"""Real desktop (Tauri + WebView2) validation and performance run.

Requires the app to be running with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
--remote-debugging-port=9222 and built with VITE_EDITOR_METRICS=1.

    python inkstone/scripts/perf/tauri_desktop_perf.py
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
OUT = ROOT / "analysis" / "perf" / "tauri-desktop.json"
MODELS = ("T1", "T3", "T4")
ROUNDS = {"T1": 3, "T3": 3, "T4": 2}


def pct(values, p):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (p / 100.0) * (len(ordered) - 1)
    lo, hi = int(rank), min(int(rank) + 1, len(ordered) - 1)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo), 2)


def summarize(snapshot):
    by = {}
    for sample in snapshot.get("samples", []):
        by.setdefault(sample["name"], []).append(sample["ms"])
    return {
        name: {"n": len(vals), "p50": pct(vals, 50), "p95": pct(vals, 95), "max": max(vals)}
        for name, vals in sorted(by.items())
    }


def open_doc(page, name):
    page.locator(".tree-row").filter(has_text=name).first.click()
    page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
    page.wait_for_timeout(1200)
    page.locator(".milkdown .ProseMirror").click()
    page.keyboard.press("Control+End")
    page.wait_for_timeout(150)


def main() -> int:
    reports = {"env": {}, "models": {}, "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        page = browser.contexts[0].pages[0]
        page.on("pageerror", lambda e: reports["errors"].append(str(e)))
        page.set_viewport_size({"width": 1440, "height": 900})
        page.evaluate(
            "(ws) => { localStorage.clear(); localStorage.setItem('inkstone.workspace.v1', ws); }",
            WS_SLASH,
        )
        page.reload(wait_until="load")
        page.wait_for_selector(".tree-row", timeout=30000)
        page.wait_for_timeout(1200)
        reports["env"] = page.evaluate(
            "() => ({ ua: navigator.userAgent, dpr: devicePixelRatio,"
            " viewport: innerWidth + 'x' + innerHeight,"
            " metrics: !!window.__inkMetrics, testHook: !!window.__inkTest })"
        )
        print("ENV:", json.dumps(reports["env"]))

        for model in MODELS:
            path = WS / (model + ".md")
            original = path.read_text(encoding="utf-8")
            model_report = {"bytes": len(original.encode()), "rounds": []}
            try:
                open_doc(page, model + ".md")
                for round_index in range(1, ROUNDS.get(model, 3) + 1):
                    page.evaluate("() => window.__inkMetrics.clear()")
                    marker = "round%d" % round_index
                    page.keyboard.type(marker, delay=25)
                    page.wait_for_timeout(60)
                    during = page.evaluate("() => window.__inkMetrics.snapshot()")
                    payload = "".join(chr(ord("a") + (i % 26)) for i in range(120))
                    page.keyboard.type(payload, delay=20)
                    page.wait_for_timeout(80)
                    during2 = page.evaluate("() => window.__inkMetrics.snapshot()")
                    page.wait_for_timeout(2200)
                    idle = page.evaluate("() => window.__inkMetrics.snapshot()")
                    model_report["rounds"].append({
                        "round": round_index,
                        "during_short_burst": {
                            "stats": summarize(during),
                            "longtasks": during.get("longTasks", []),
                        },
                        "during_continuous": {
                            "stats": summarize(during2),
                            "longtasks": during2.get("longTasks", []),
                        },
                        "after_idle": {
                            "stats": summarize(idle),
                            "longtasks": idle.get("longTasks", []),
                            "memory_mb": round(((idle.get("memory") or {}).get("usedJSHeapSize") or 0) / 1e6, 1),
                        },
                    })
                    print(model, "round", round_index, "continuous stats:",
                          json.dumps({k: v for k, v in summarize(during2).items()
                                      if k in ("input_to_frame", "event_input", "app_render", "react_commit_span")}))

                # mode switch keeps the newest text and reports its own timings
                final_marker = "switchmark"
                page.keyboard.type(final_marker, delay=20)
                page.wait_for_timeout(100)
                switches = []
                for switch_index in range(2):
                    page.evaluate("() => window.__inkMetrics.clear()")
                    page.keyboard.press("Control+e")
                    page.wait_for_selector(".cm-content" if switch_index % 2 == 0 else ".milkdown .ProseMirror", timeout=30000)
                    page.wait_for_timeout(200)
                    switch_snap = page.evaluate("() => window.__inkMetrics.snapshot()")
                    switches.append({"direction": "rich->source" if switch_index % 2 == 0 else "source->rich",
                                     "round": switch_index // 2 + 1, "stats": summarize(switch_snap)})
                tab = page.evaluate("() => window.__inkTest ? window.__inkTest.activeTab() : null")
                model_report["mode_switch_content_ok"] = bool(tab and final_marker in (tab.get("content") or ""))
                model_report["mode_switches"] = switches

                # explicit save writes the newest text to the real disk
                page.locator(".milkdown .ProseMirror").click()
                page.keyboard.press("Control+End")
                page.keyboard.type(" diskmark", delay=20)
                page.keyboard.press("Control+s")
                deadline = time.time() + 8
                saved = False
                while time.time() < deadline:
                    if "diskmark" in path.read_text(encoding="utf-8", errors="ignore"):
                        saved = True
                        break
                    time.sleep(0.15)
                model_report["disk_save_ok"] = saved
                model_report["mode_switch_stats"] = {}
                snap = page.evaluate("() => window.__inkMetrics.snapshot()")
                model_report["memory_mb"] = round(((snap.get("memory") or {}).get("usedJSHeapSize") or 0) / 1e6, 1)
            finally:
                path.write_text(original, encoding="utf-8")
            reports["models"][model] = model_report
            print(model, "content_ok=", model_report.get("mode_switch_content_ok"),
                  "disk_save_ok=", model_report.get("disk_save_ok"),
                  "memory_mb=", model_report.get("memory_mb"))
        browser.close()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", OUT)
    print("page errors:", reports["errors"][:3])
    return 0


if __name__ == "__main__":
    sys.exit(main())
