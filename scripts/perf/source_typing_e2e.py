from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent.parent

def percentile(values, pct):
    values = sorted(float(v) for v in values)
    if not values:
        return None
    rank = (len(values) - 1) * pct
    low = math.floor(rank)
    high = math.ceil(rank)
    return values[low] if low == high else values[low] + (values[high] - values[low]) * (rank - low)

def summary(snapshot):
    samples = snapshot.get("samples", [])
    def series(name):
        return [s["ms"] for s in samples if s.get("name") == name]
    return {
        "input_to_frame_p95": percentile(series("input_to_frame"), .95),
        "input_to_frame_max": max(series("input_to_frame"), default=None),
        "stats_runs": len(series("stats")),
        "outline_runs": len(series("outline")),
        "snapshot_runs": len(series("markdown_snapshot")),
        "flush_runs": len(series("markdown_flush")),
        "long_tasks": len(snapshot.get("longTasks", [])),
        "last_doc_size": next((s.get("meta") for s in reversed(samples) if s.get("name") == "doc_size"), None),
    }

def main():
    parser = argparse.ArgumentParser(description="测量源码模式连续输入与延迟派生计算")
    parser.add_argument("--url", default="http://127.0.0.1:1420")
    parser.add_argument("--model", choices=["ascii", "cjk"], default="ascii")
    parser.add_argument("--chars", type=int, default=32)
    args = parser.parse_args()
    workspace = "C:/source-perf"
    path = workspace + "/" + args.model + ".md"
    content = "0123456789abcdef" * 20000 if args.model == "ascii" else "汉字写作内容。" * 10000
    out = ROOT.parent / "analysis" / "perf"
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
        seed = (
            "window.__PERF_FS = " + json.dumps({path: content}) + ";"
            "window.__PERF_WORKSPACE = " + json.dumps(workspace) + ";"
            "window.__PERF_DIALOG = null;"
            "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(workspace) + ");"
            "localStorage.removeItem('inkstone.drafts.v1');"
            "localStorage.setItem('inkstone.settings.v1', JSON.stringify({autoSave:false,showOutline:true,showSidebar:true}));"
        )
        context.add_init_script(seed + "\n" + mock)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url, wait_until="networkidle")
        page.locator(".tree-row").filter(has_text=args.model + ".md").first.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=45000)
        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".cm-content", timeout=30000)
        page.wait_for_timeout(700)
        page.locator(".cm-content").click()
        page.keyboard.press("Control+End")
        page.evaluate("() => window.__inkMetrics.clear()")
        page.keyboard.type("x" * args.chars, delay=2)
        page.wait_for_timeout(100)
        during = summary(page.evaluate("() => window.__inkMetrics.snapshot()"))
        page.wait_for_timeout(2100)
        settled_snapshot = page.evaluate("() => window.__inkMetrics.snapshot()")
        settled = summary(settled_snapshot)
        report = {
            "model": args.model,
            "document_characters": len(content),
            "typed_characters": args.chars,
            "during": during,
            "settled": settled,
            "page_errors": errors,
            "ok": during["stats_runs"] == 0 and during["outline_runs"] == 0 and settled["stats_runs"] >= 1 and not errors,
        }
        (out / ("source-" + args.model + ".json")).write_text(json.dumps({"summary": report, "metrics": settled_snapshot}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        browser.close()
        return 0 if report["ok"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
