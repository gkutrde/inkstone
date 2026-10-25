#!/usr/bin/env python3
"""Typing-smoothness benchmark driver for Inkstone.

What it does
------------
1. Launches headless Chromium with a 1440x900 viewport.
2. Injects scripts/perf/tauri_mock.js before navigation, seeding an in-memory
   filesystem with one fixture document at C:/perf/workspace/<model>.md.
3. Loads the app, pins the workspace through localStorage, and reloads so the
   real boot path (App reads inkstone.workspace.v1 on mount) is exercised.
4. Opens the fixture from the sidebar, parks the caret at the end of the
   document, clears window.__inkMetrics, and types N short ASCII bursts.
5. Reads window.__inkMetrics.snapshot() and writes a JSON report with env,
   raw samples, per-metric percentiles, long tasks and React commits.

Example (run from the repository root):
    python inkstone/scripts/perf/bench.py --model T1 --bursts 10 --chars 12 \
        --url http://127.0.0.1:4173 --out analysis/perf/T1.json

The module also exposes reuse helpers for other scripts: open_document(),
read_metrics(), clear_metrics(), probe_serialize() and summarize().
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from playwright.sync_api import sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[2]  # <root>/inkstone/scripts/perf -> <root>
DEFAULT_OUT_DIR = ROOT / "analysis" / "perf"
DEFAULT_WORKSPACE = "C:/perf/workspace"

# Metrics the smoke gate cares about. Missing ones are reported as null rather
# than aborting the run: a partial report is more useful than no report.
EXPECTED_METRICS = (
    "input_to_editor_notify",
    "input_to_commit",
    "markdown_serialize",
    "react_commit_span",
    "markdown_snapshot",
)

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import fixtures  # noqa: E402

# One-line snippets: page.evaluate() takes a function source plus one argument.
JS_SET_WORKSPACE = (
    "(ws) => { localStorage.setItem('inkstone.workspace.v1', ws);"
    " localStorage.removeItem('inkstone.drafts.v1'); return true; }"
)
JS_CLEAR_METRICS = (
    "() => { const m = window.__inkMetrics;"
    " if (!m || typeof m.clear !== 'function') return false;"
    " m.clear(); return true; }"
)
JS_PROBE_SERIALIZE = (
    "() => { const m = window.__inkMetrics;"
    " if (!m || typeof m.probeSerialize !== 'function') return false;"
    " return m.probeSerialize() !== false; }"
)
JS_SNAPSHOT = (
    "() => { const m = window.__inkMetrics;"
    " if (!m || typeof m.snapshot !== 'function') return null;"
    " try { return m.snapshot(); } catch (error) { return null; } }"
)
JS_EDITOR_STATE = (
    "() => { const node = document.querySelector('.milkdown .ProseMirror');"
    " return node ? { mounted: true, blocks: node.children.length,"
    " text: (node.innerText || '').length } : { mounted: false, blocks: 0, text: 0 }; }"
)


# ------------------------------------------------------------- page setup ---

def build_init_script(mock_source: str, doc_path: str, content: str, workspace: str) -> str:
    """Compose the add_init_script payload: seed globals, then the mock itself."""
    seed = (
        ("window.__PERF_FS", {doc_path: content}),
        ("window.__PERF_WORKSPACE", workspace),
        ("window.__PERF_DIALOG", None),
    )
    preamble = "".join(
        name + " = " + json.dumps(value, ensure_ascii=True) + ";" for name, value in seed
    )
    return preamble + chr(10) + mock_source


def wait_for_app(page, timeout_ms: int = 30000) -> None:
    """Wait until the React shell has rendered."""
    page.wait_for_selector(".app", timeout=timeout_ms)


def open_document(page, path: str, timeout_ms: int = 30000) -> None:
    """Click the sidebar row for path and wait until the rich editor mounts."""
    normalized = path.replace(chr(92), "/")
    name = normalized.rsplit("/", 1)[-1]
    row = page.locator('.tree-row[data-path="' + normalized + '"]')
    if row.count() == 0:
        # Fall back to a name match when the row markup does not carry data-path.
        row = page.locator(".tree-row").filter(has_text=name)
    if row.count() == 0:
        raise RuntimeError("file row not found in sidebar: " + normalized)
    row.first.click(timeout=timeout_ms)
    page.wait_for_selector(".milkdown .ProseMirror", timeout=timeout_ms)
    # Milkdown mounts the ProseMirror view before the document is painted.
    try:
        page.wait_for_selector(".milkdown .ProseMirror p", timeout=min(timeout_ms, 10000))
    except Exception:
        pass


def editor_state(page) -> dict:
    """Small diagnostic: did the editor mount, and does it hold any text?"""
    try:
        state = page.evaluate(JS_EDITOR_STATE)
    except Exception:
        return {"mounted": False, "blocks": 0, "text": 0}
    return state if isinstance(state, dict) else {"mounted": False, "blocks": 0, "text": 0}


def clear_metrics(page) -> bool:
    """Reset the in-page ring buffers. Returns False when instrumentation is off."""
    try:
        return bool(page.evaluate(JS_CLEAR_METRICS))
    except Exception:
        return False


def probe_serialize(page) -> bool:
    """Ask the editor to serialize the whole document once (markdown_serialize)."""
    try:
        return bool(page.evaluate(JS_PROBE_SERIALIZE))
    except Exception:
        return False


def read_metrics(page) -> dict | None:
    """Return window.__inkMetrics.snapshot(), or None when it is unavailable."""
    try:
        snapshot = page.evaluate(JS_SNAPSHOT)
    except Exception:
        return None
    return snapshot if isinstance(snapshot, dict) else None


# ---------------------------------------------------------------- analysis ---

def to_float(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def percentile(ordered: list[float], pct: float) -> float | None:
    """Linear-interpolated percentile over an already sorted list."""
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return ordered[low]
    weight = rank - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def summarize(values) -> dict:
    """p50/p95/p99/max/count for one metric series; nulls when empty."""
    numbers = sorted(to_float(value) for value in values)
    if not numbers:
        return {"count": 0, "min": None, "p50": None, "p95": None, "p99": None, "max": None, "mean": None}
    return {
        "count": len(numbers),
        "min": round(numbers[0], 3),
        "p50": round(percentile(numbers, 50), 3),
        "p95": round(percentile(numbers, 95), 3),
        "p99": round(percentile(numbers, 99), 3),
        "max": round(numbers[-1], 3),
        "mean": round(sum(numbers) / len(numbers), 3),
    }


def build_stats(snapshot: dict | None, expected=EXPECTED_METRICS) -> tuple[dict, list[str]]:
    """Group samples by name and add react_commit / longtask derived series."""
    snapshot = snapshot or {}
    samples = snapshot.get("samples") or []
    commits = snapshot.get("commits") or []
    long_tasks = snapshot.get("longTasks") or []

    series: dict[str, list[float]] = {}
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        name = sample.get("name")
        if not isinstance(name, str) or not name:
            continue
        series.setdefault(name, []).append(to_float(sample.get("ms")))

    # React commits are stored separately by recordCommit(); expose them under
    # the same stats shape the smoke gate asks for (react_commit).
    if commits:
        series["react_commit"] = [to_float(commit.get("actualDuration")) for commit in commits if isinstance(commit, dict)]
    if long_tasks:
        series["longtask"] = [to_float(task.get("duration")) for task in long_tasks if isinstance(task, dict)]

    stats = {name: summarize(values) for name, values in sorted(series.items())}
    missing = [name for name in expected if not series.get(name)]
    for name in expected:
        stats.setdefault(name, summarize([]))
    return stats, missing


def rename_hints(missing, stats: dict) -> dict:
    """Point a missing contract metric at observed names from the same stage.

    The app's instrumentation is renamed from time to time (for example
    input_to_markdown -> input_to_editor_notify). This never rewrites numbers;
    it only tells the reader which observed metric looks like the successor.
    """
    keywords = {
        "input_to_markdown": ("markdown",),
        "input_to_commit": ("commit",),
        "markdown_serialize": ("serialize",),
        "react_commit": ("commit",),
    }
    hints = {}
    observed = [name for name, row in stats.items() if name and row.get("count", 0) > 0]
    for name in missing:
        needles = keywords.get(name, tuple(part for part in name.split("_") if len(part) > 2))
        candidates = sorted(
            other for other in observed
            if other != name and any(needle in other for needle in needles)
        )
        if candidates:
            hints[name] = candidates
    return hints


def format_number(value) -> str:
    return "-" if value is None else "{:.2f}".format(value)


def print_table(stats: dict, expected=EXPECTED_METRICS) -> None:
    order = list(expected) + sorted(name for name in stats if name not in expected)
    print("")
    print("{:<32}{:>9}{:>9}{:>9}{:>9}{:>6}".format("metric", "p50", "p95", "p99", "max", "n"))
    print("-" * 74)
    for name in order:
        row = stats.get(name) or summarize([])
        print("{:<32}{:>9}{:>9}{:>9}{:>9}{:>6}".format(
            name,
            format_number(row.get("p50")),
            format_number(row.get("p95")),
            format_number(row.get("p99")),
            format_number(row.get("max")),
            str(row.get("count", 0)),
        ))


# ------------------------------------------------------------------ driver ---

def burst_text(index: int, chars: int) -> str:
    """ASCII-only burst payload; safe for ProseMirror input rules."""
    prefix = "b" + str(index).zfill(2) + " "
    filler = "typingsmoothnessprobe"
    if chars <= len(prefix):
        return prefix[: max(1, chars)]
    repeats = (chars // len(filler)) + 2
    return (prefix + filler * repeats)[:chars]


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except (PackageNotFoundError, Exception):
        return None


def _screenshot(page, path: Path) -> str | None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path))
        return str(path)
    except Exception:
        return None


def run(args) -> int:
    model = args.model.upper()
    expected = tuple(name.strip() for name in (args.expect or "").split(",") if name.strip()) or EXPECTED_METRICS
    workspace = args.workspace.rstrip("/")
    doc_name = args.doc_name or (model + ".md")
    doc_path = workspace + "/" + doc_name
    url = args.url
    out_path = Path(args.out) if args.out else DEFAULT_OUT_DIR / (model + ".json")
    mock_path = Path(args.mock)

    content = fixtures.generate(model)
    fixture_info = fixtures.describe(content)
    fixture_info.update({
        "model": model,
        "name": doc_name,
        "path": doc_path,
        "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    })

    mock_source = mock_path.read_text(encoding="utf-8")
    init_script = build_init_script(mock_source, doc_path, content, workspace)

    config = {
        "bursts": args.bursts,
        "chars": args.chars,
        "typing_delay_ms": args.burst_delay,
        "burst_gap_ms": args.burst_gap,
        "pre_typing_settle_ms": args.settle,
        "post_burst_wait_ms": 500,
        "post_probe_wait_ms": 100,
        "viewport": {"width": 1440, "height": 900},
        "headless": True,
        "workspace": workspace,
        "mock": str(mock_path),
    }

    page_errors: list[str] = []
    console_errors: list[str] = []
    snapshot = None
    mounted = False
    cleared = False
    serialize_ran = False
    chrome_version = None
    state = {"mounted": False, "blocks": 0, "text": 0}
    page = None
    started = time.time()

    print("Inkstone typing benchmark")
    print("  model      : " + model)
    print("  url        : " + url)
    print("  fixture    : " + doc_name + " (" + str(fixture_info["bytes"]) + " bytes, "
          + str(fixture_info["headings"]) + " headings)")
    print("  bursts     : " + str(args.bursts) + " x " + str(args.chars) + " chars, "
          + str(args.burst_delay) + " ms/char, " + str(args.burst_gap) + " ms gap")
    print("  output     : " + str(out_path))

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                args=[
                    "--disable-background-timer-throttling",
                    "--disable-renderer-backgrounding",
                    "--disable-backgrounding-occluded-windows",
                ],
            )
            chrome_version = browser.version
            context = browser.new_context(
                viewport={"width": 1440, "height": 900},
                device_scale_factor=1,
            )
            page = context.new_page()
            page.add_init_script(init_script)
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on(
                "console",
                lambda message: console_errors.append(message.text) if message.type == "error" else None,
            )

            page.goto(url, wait_until="load", timeout=args.timeout)
            wait_for_app(page, args.timeout)
            page.evaluate(JS_SET_WORKSPACE, workspace)
            page.reload(wait_until="load", timeout=args.timeout)
            page.wait_for_selector(".tree-row", timeout=args.timeout)
            open_document(page, doc_path, args.timeout)
            mounted = True
            page.wait_for_timeout(args.settle)

            state = editor_state(page)
            editor = page.locator(".milkdown .ProseMirror").first
            # Focus the editor and park the caret at the end of the document.
            try:
                paragraphs = editor.locator("p")
                if paragraphs.count() > 0:
                    paragraphs.nth(paragraphs.count() - 1).click(timeout=5000)
                else:
                    editor.click(timeout=5000)
            except Exception:
                editor.click(timeout=5000)
            page.keyboard.press("Control+End")
            page.wait_for_timeout(50)

            cleared = clear_metrics(page)
            for index in range(args.bursts):
                page.keyboard.type(burst_text(index, args.chars), delay=args.burst_delay)
                page.wait_for_timeout(args.burst_gap)

            page.wait_for_timeout(500)
            serialize_ran = probe_serialize(page)
            page.wait_for_timeout(100)
            snapshot = read_metrics(page)

            if snapshot is None:
                _screenshot(page, DEFAULT_OUT_DIR / (model + "-no-metrics.png"))
            browser.close()
    except Exception as error:
        print("BENCH ERROR: " + str(error))
        if page is not None:
            shot = _screenshot(page, DEFAULT_OUT_DIR / (model + "-failure.png"))
            if shot:
                print("  screenshot : " + shot)
        for item in page_errors[:10]:
            print("  pageerror  : " + item)
        return 2

    duration_s = round(time.time() - started, 3)
    stats, missing = build_stats(snapshot, expected)
    hints = rename_hints(missing, stats)
    snapshot = snapshot or {}
    snapshot_env = snapshot.get("env") or {}

    notes = []
    for name, candidates in hints.items():
        notes.append(
            name + " missing; observed metrics from a similar stage: " + ", ".join(candidates)
        )
    if "react_commit" in missing and not (snapshot.get("commits") or []):
        # React 19 compiles Profiler.onRender out of the default production
        # build, so recordCommit() never runs there. The metric needs a
        # react-dom/profiling bundle (or the dev server).
        notes.append(
            "react_commit unavailable: React production bundles compile out Profiler.onRender; "
            "build the perf bundle against react-dom/profiling to sample commit durations."
        )
    if not cleared:
        notes.append("window.__inkMetrics.clear() was unavailable; samples cover the whole session.")
    if page_errors:
        notes.append(str(len(page_errors)) + " page error(s) recorded; see page_errors.")

    env = {
        "url": url,
        "user_agent": snapshot_env.get("ua"),
        "viewport": snapshot_env.get("viewport") or "1440x900",
        "device_pixel_ratio": snapshot_env.get("devicePixelRatio"),
        "metrics_enabled": bool(snapshot.get("enabled")),
        "headless": True,
        "browser": "chromium " + (chrome_version or "unknown"),
        "playwright": _package_version("playwright"),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "memory": snapshot.get("memory"),
    }

    report = {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "ok": bool(snapshot) and mounted,
        "duration_s": duration_s,
        "fixture": fixture_info,
        "config": config,
        "env": env,
        "editor": state,
        "cleared": cleared,
        "serialize_probe": serialize_ran,
        "counts": snapshot.get("counts"),
        "samples": snapshot.get("samples") or [],
        "long_tasks": snapshot.get("longTasks") or [],
        "commits": snapshot.get("commits") or [],
        "stats": stats,
        "expected_metrics": list(expected),
        "missing_metrics": missing,
        "rename_hints": hints,
        "notes": notes,
        "page_errors": page_errors,
        "console_errors": console_errors,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write(chr(10))

    print("")
    print("  mounted    : " + str(mounted) + "  metrics: " + str(env["metrics_enabled"])
          + "  cleared: " + str(cleared) + "  serialize probe: " + str(serialize_ran))
    print("  editor     : blocks=" + str(state.get("blocks")) + " text=" + str(state.get("text")))
    print("  page errors: " + str(len(page_errors)) + "   console errors: " + str(len(console_errors)))
    print("  snapshot   : samples=" + str((snapshot.get("counts") or {}).get("samples"))
          + " commits=" + str((snapshot.get("counts") or {}).get("commits"))
          + " longTasks=" + str((snapshot.get("counts") or {}).get("longTasks")))
    print_table(stats, expected)
    if missing:
        print("")
        print("WARNING missing metrics: " + ", ".join(missing) + " (reported as null)")
    for note in notes:
        print("NOTE: " + note)

    problems = []
    if not mounted:
        problems.append("editor did not mount")
    if not snapshot:
        problems.append("window.__inkMetrics unavailable")
    if missing:
        problems.append("missing metrics: " + ", ".join(missing))
    if page_errors:
        problems.append(str(len(page_errors)) + " page error(s)")
    if args.strict and problems:
        print("STRICT FAIL: " + "; ".join(problems))
        return 1
    if problems:
        print("WARN: " + "; ".join(problems))
    print("wrote " + str(out_path))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Measure Inkstone typing smoothness in headless Chromium.")
    parser.add_argument("--model", default="T1", choices=list(fixtures.MODELS), help="fixture model to type into")
    parser.add_argument("--bursts", type=int, default=10, help="number of typing bursts")
    parser.add_argument("--chars", type=int, default=12, help="ASCII characters per burst")
    parser.add_argument("--url", default="http://127.0.0.1:4173", help="app URL (dev 1420 or built 4173)")
    parser.add_argument("--out", default="", help="JSON output path (default analysis/perf/<MODEL>.json)")
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE, help="mock workspace root")
    parser.add_argument("--doc-name", default="", help="fixture file name inside the workspace")
    parser.add_argument("--mock", default=str(SCRIPT_DIR / "tauri_mock.js"), help="Tauri IPC mock source")
    parser.add_argument("--burst-delay", type=int, default=25, help="delay between keystrokes in ms")
    parser.add_argument("--burst-gap", type=int, default=250, help="pause between bursts in ms")
    parser.add_argument("--settle", type=int, default=800, help="settle time after the editor mounts")
    parser.add_argument("--timeout", type=int, default=30000, help="per-selector timeout in ms")
    parser.add_argument(
        "--expect",
        default="",
        help="comma-separated metric names that must be present (default: " + ",".join(EXPECTED_METRICS) + ")",
    )
    parser.add_argument("--strict", action="store_true", help="exit non-zero when page errors or metrics are missing")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.bursts = max(1, args.bursts)
    args.chars = max(2, args.chars)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
