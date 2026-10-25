#!/usr/bin/env python3
"""Deterministic Markdown fixtures for the Inkstone typing benchmark.

Models
------
T0  blank            empty document, the plumbing baseline
T1  typical          ~30 KB mix of headings, lists, links, quotes and code
T2  structural       exactly 200 headings plus tables, task lists, fences
T3  long             ~250 KB multi-chapter document
T4  stress           ~1 MB dense document (many blocks, tables, inline markup)
T5  images           several PNG data URIs, one deliberately large
T6  chinese          long Chinese prose with headings

Every model is generated from a fixed seed, so the same model always yields
byte-identical output. Run directly to materialise all fixtures:

    python inkstone/scripts/perf/fixtures.py
    python inkstone/scripts/perf/fixtures.py T1 T6 --out-dir analysis/perf-fixtures
"""

from __future__ import annotations

import argparse
import base64
import random
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT_DIR = ROOT / "analysis" / "perf-fixtures"

MODELS = ("T0", "T1", "T2", "T3", "T4", "T5", "T6")

# Newlines and backticks are built from code points so this module stays free
# of escape sequences: the fixture text must be readable and copy-paste safe.
NL = chr(10)
TICK = chr(96)
FENCE = TICK * 3
PNG_SIGNATURE = bytes([137, 80, 78, 71, 13, 10, 26, 10])

# Fixed per-model seeds: determinism must not depend on PYTHONHASHSEED.
SEEDS = {
    "T0": 20240500,
    "T1": 20240501,
    "T2": 20240502,
    "T3": 20240503,
    "T4": 20240504,
    "T5": 20240505,
    "T6": 20240506,
}

TARGET_CHARS = {
    "T1": 30_000,
    "T3": 250_000,
    "T4": 1_000_000,
    "T6": 60_000,
}

_PARAGRAPH_SENTENCES = (
    "The editor keeps a single Markdown string as the source of truth for every open tab.",
    "Each keystroke travels through ProseMirror, the Markdown serializer and React before it paints.",
    "A benchmark that only measures the average hides the pauses a writer actually feels.",
    "Long tasks above fifty milliseconds are the ones a typist can notice without trying.",
    "Autosave runs on a debounce, so a fast burst of typing collapses into one disk write.",
    "The outline and the word count are derived values, recomputed after the document settles.",
    "Structural markdown such as tables and fences costs more to parse than plain paragraphs.",
    "We keep the fixture byte-identical between runs so two measurements are comparable.",
    "A cold start includes font loading and syntax highlighting, so warm-up is measured apart.",
    "Percentiles describe the tail better than the mean, but the tail still needs a sample size.",
    "Source mode swaps the rich editor for CodeMirror and changes the input pipeline entirely.",
    "Images embedded as data URIs make the document heavier without touching the hot path.",
    "The harness drives a real browser over HTTP, so the numbers include realistic layout work.",
    "Conflict detection compares the stored modification time and size before every save.",
    "A regression is only credible when the same script produces the same shape of report.",
)

_CHINESE_SENTENCES = (
    "写作的流畅感来自每一次按键都能被及时看见，而不是来自某个平均值。",
    "编辑器把整篇文稿保存成一段 Markdown 文本，所有面板都从这份文本派生。",
    "当文档长到几百页以后，重排与序列化的成本会一起浮出水面。",
    "真正的卡顿往往出现在长任务里，而不是出现在输入事件本身。",
    "自动保存按防抖节奏触发，所以连续敲击只会落成一次磁盘写入。",
    "大纲、字数和匹配结果都是派生数据，必须等正文稳定之后再计算。",
    "表格、代码块与任务列表的结构比普通段落更重，也更容易暴露瓶颈。",
    "为了让两次测量可以比较，基准文稿必须逐字节一致。",
    "冷启动包含字体加载与语法高亮，因此预热阶段要单独计时。",
    "分位数比平均值更能描述尾部延迟，但尾部同样需要足够的样本。",
    "源码模式会把富文本编辑器换成另一套输入管线，读数的含义也随之改变。",
    "内嵌图片会让文档变重，却未必影响敲击路径上的开销。",
    "测试脚本驱动真实浏览器访问本地服务，因此读数包含了真实的排版成本。",
    "保存前会比对修改时间与文件大小，用来发现编辑器之外的改动。",
    "只有同一脚本产出同样形状的报告，性能回归才值得相信。",
    "把一段话拆成多个短段落，比堆成一个超长段落更接近真实写作。",
    "光标的移动、选区的变化和输入法组合事件都会影响最终的手感。",
    "我们把测量拆成输入、序列化、提交与绘制四个阶段，分别观察。",
)


# --------------------------------------------------------------- PNG data ---

def _png_bytes(width: int, height: int, pixel) -> bytes:
    """Build a minimal 8-bit RGB PNG. pixel(x, y) -> (r, g, b)."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        for x in range(width):
            raw.extend(pixel(x, y))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def _data_uri(width: int, height: int, pixel) -> str:
    encoded = base64.b64encode(_png_bytes(width, height, pixel)).decode("ascii")
    return "data:image/png;base64," + encoded


def _gradient(width: int, height: int, offset: int):
    def pixel(x: int, y: int):
        return ((x * 15 + offset) % 256, (y * 17 + offset) % 256, ((x + y) * 9 + offset) % 256)

    return pixel


def _noise(width: int, height: int, seed: int):
    """Cheap deterministic LCG so the larger image does not compress away."""
    state = seed & 0xFFFFFFFF

    def pixel(_x: int, _y: int):
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return ((state >> 16) & 0xFF, (state >> 8) & 0xFF, state & 0xFF)

    return pixel


# ---------------------------------------------------------------- helpers ---

def _heading(level: int, text: str) -> str:
    return "#" * level + " " + text + NL * 2


def _paragraph(rng: random.Random, count: int = 3) -> str:
    chosen = [rng.choice(_PARAGRAPH_SENTENCES) for _ in range(count)]
    return " ".join(chosen) + NL * 2


def _bullet_list(rng: random.Random, items: int) -> str:
    lines = []
    for index in range(items):
        lines.append("- " + rng.choice(_PARAGRAPH_SENTENCES))
        if index % 3 == 2:
            lines.append("  - Nested detail so the list is not flat.")
    return NL.join(lines) + NL * 2


def _ordered_list(rng: random.Random, items: int) -> str:
    lines = []
    for index in range(items):
        lines.append(str(index + 1) + ". " + rng.choice(_PARAGRAPH_SENTENCES))
    return NL.join(lines) + NL * 2


def _code_fence(language: str, index: int) -> str:
    body = [
        "function measure" + str(index) + "(doc) {",
        "  const started = performance.now();",
        "  const text = serialize(doc);",
        "  const elapsed = performance.now() - started;",
        "  return { text, elapsed, bytes: text.length };",
        "}",
    ]
    return FENCE + language + NL + NL.join(body) + NL + FENCE + NL * 2


def _table(rows: int, columns: int = 3) -> str:
    header = "| " + " | ".join("Column " + str(index + 1) for index in range(columns)) + " |"
    divider = "| " + " | ".join("---" for _ in range(columns)) + " |"
    body = []
    for row in range(rows):
        cells = ["Cell " + str(row + 1) + "." + str(column + 1) for column in range(columns)]
        body.append("| " + " | ".join(cells) + " |")
    return NL.join([header, divider] + body) + NL * 2


def _task_list(items: int, done_every: int = 3) -> str:
    lines = []
    for index in range(items):
        mark = "x" if index % done_every == 0 else " "
        lines.append("- [" + mark + "] Checklist item " + str(index + 1) + ": verify the editor still feels immediate.")
    return NL.join(lines) + NL * 2


def _quote(rng: random.Random) -> str:
    return "> " + rng.choice(_PARAGRAPH_SENTENCES) + NL + ">" + NL + "> note for the benchmark" + NL * 2


def _links(rng: random.Random, count: int) -> str:
    parts = []
    for index in range(count):
        parts.append(
            "[reference " + str(index + 1) + "](https://example.com/docs/" + str(index + 1) + ")"
            + " and [cached copy](https://example.com/cache?id=" + str(index + 1) + "&ref=perf)"
        )
    return "See " + ", ".join(parts) + " for the surrounding context." + NL * 2


def _inline_markup(index: int) -> str:
    return (
        "Paragraph " + str(index) + " carries **bold text**, *italic text*, " + TICK + "inline code" + TICK + ", "
        + "~~struck text~~ and a [link](https://example.com/perf/" + str(index) + ") so inline "
        "decoration has to be parsed on every keystroke." + NL * 2
    )


# ----------------------------------------------------------------- models ---

def _t0() -> str:
    return ""


def _t1() -> str:
    rng = random.Random(SEEDS["T1"])
    parts = [_heading(1, "Typing benchmark: typical document")]
    parts.append(
        "This fixture is deliberately ordinary. It mixes the block types an "
        "author actually uses, at a size where a regression is visible without "
        "waiting a minute for the document to settle." + NL * 2
    )
    section = 0
    length = sum(len(part) for part in parts)
    while length < TARGET_CHARS["T1"]:
        section += 1
        block = []
        block.append(_heading(2, "Section " + str(section) + ": routine writing"))
        block.append(_paragraph(rng))
        block.append(_bullet_list(rng, 4))
        if section % 2 == 0:
            block.append(_heading(3, "Detail " + str(section) + ".1"))
            block.append(_paragraph(rng, 2))
            block.append(_ordered_list(rng, 3))
        if section % 3 == 0:
            block.append(_quote(rng))
        if section % 4 == 0:
            block.append(_code_fence("js", section))
        if section % 5 == 0:
            block.append(_table(3))
        block.append(_links(rng, 2))
        text = "".join(block)
        parts.append(text)
        length += len(text)
    parts.append("Closing paragraph so the caret lands in prose after Control+End." + NL)
    return "".join(parts)


def _t2() -> str:
    """Exactly 200 ATX headings: 1 h1 + 40 h2 + 120 h3 + 39 h4."""
    rng = random.Random(SEEDS["T2"])
    parts = [_heading(1, "Structural pressure: two hundred headings")]
    parts.append("Counted headings are part of the contract for this fixture." + NL * 2)
    heading_count = 1
    h4_budget = 39
    for section in range(1, 41):
        parts.append(_heading(2, "Chapter " + str(section).zfill(2)))
        parts.append(_paragraph(rng, 2))
        heading_count += 1
        if section <= 6:
            parts.append(_table(4, 4))
        if section <= 8:
            parts.append(_task_list(5))
            parts.append(_code_fence("python", section))
        for sub in range(1, 4):
            parts.append(_heading(3, "Chapter " + str(section).zfill(2) + "." + str(sub)))
            heading_count += 1
            parts.append(_paragraph(rng, 2))
            if h4_budget > 0 and section <= 13:
                parts.append(_heading(4, "Note " + str(section).zfill(2) + "." + str(sub)))
                heading_count += 1
                h4_budget -= 1
                parts.append(_paragraph(rng, 1))
            parts.append(_bullet_list(rng, 2))
    parts.append("Closing paragraph after the final heading." + NL)
    assert heading_count == 200, heading_count
    return "".join(parts)


def _t3() -> str:
    rng = random.Random(SEEDS["T3"])
    parts = [_heading(1, "Long document: two hundred and fifty kilobytes")]
    parts.append(
        "A long document changes the cost profile of everything downstream: "
        "serialization, outline extraction, word counting and autosave." + NL * 2
    )
    chapter = 0
    length = sum(len(part) for part in parts)
    while length < TARGET_CHARS["T3"]:
        chapter += 1
        block = [_heading(2, "Chapter " + str(chapter) + ": sustained writing")]
        block.append(_paragraph(rng, 4))
        for sub in range(1, 4):
            block.append(_heading(3, "Chapter " + str(chapter) + "." + str(sub)))
            block.append(_paragraph(rng, 3))
            block.append(_bullet_list(rng, 3))
            if sub == 2:
                block.append(_table(5))
            if sub == 3:
                block.append(_code_fence("js", chapter * 10 + sub))
        block.append(_links(rng, 3))
        text = "".join(block)
        parts.append(text)
        length += len(text)
    parts.append("Closing paragraph for the long document." + NL)
    return "".join(parts)


def _t4() -> str:
    rng = random.Random(SEEDS["T4"])
    parts = [_heading(1, "Stress document: one megabyte of markdown")]
    parts.append(
        "This fixture is intentionally heavy. It is not a realistic note; it is "
        "the shape that makes a fast path look slow if one exists." + NL * 2
    )
    chunk = 0
    length = sum(len(part) for part in parts)
    while length < TARGET_CHARS["T4"]:
        chunk += 1
        block = [_heading(2, "Chunk " + str(chunk).zfill(4))]
        for paragraph in range(6):
            block.append(_inline_markup(chunk * 100 + paragraph))
        block.append(_paragraph(rng, 4))
        block.append(_bullet_list(rng, 8))
        block.append(_ordered_list(rng, 5))
        if chunk % 5 == 0:
            block.append(_table(12, 5))
        if chunk % 7 == 0:
            block.append(_code_fence("ts", chunk))
        if chunk % 11 == 0:
            block.append(_task_list(8, done_every=2))
            block.append(_quote(rng))
        block.append(_links(rng, 4))
        text = "".join(block)
        parts.append(text)
        length += len(text)
    parts.append("Closing paragraph for the stress document." + NL)
    return "".join(parts)


def _t5() -> str:
    rng = random.Random(SEEDS["T5"])
    small_a = _data_uri(12, 12, _gradient(12, 12, 10))
    small_b = _data_uri(16, 16, _gradient(16, 16, 90))
    small_c = _data_uri(20, 12, _gradient(20, 12, 150))
    large = _data_uri(160, 120, _noise(160, 120, 12345))
    parts = [_heading(1, "Image heavy: data URI payloads")]
    parts.append(
        "Images stored as data URIs travel with the document. They make the "
        "Markdown string longer without adding structure, which is exactly the "
        "case worth measuring separately from textual load." + NL * 2
    )
    parts.append(_heading(2, "Small images"))
    parts.append("![Gradient thumbnail A](" + small_a + ")" + NL * 2)
    parts.append(_paragraph(rng, 2))
    parts.append("![Gradient thumbnail B](" + small_b + ")" + NL * 2)
    parts.append(_paragraph(rng, 2))
    parts.append("![Gradient thumbnail C](" + small_c + ")" + NL * 2)
    parts.append(_heading(2, "Larger image"))
    parts.append(
        "The block below embeds a noisy 160x120 PNG, roughly ninety kilobytes "
        "once base64 encoded. It is large enough to move the serialization cost "
        "without dominating the fixture." + NL * 2
    )
    parts.append("![Noise reference](" + large + ")" + NL * 2)
    parts.append(_heading(2, "Text after images"))
    parts.append(_paragraph(rng, 3))
    parts.append(_bullet_list(rng, 4))
    parts.append("Closing paragraph after the images." + NL)
    return "".join(parts)


def _t6() -> str:
    rng = random.Random(SEEDS["T6"])
    parts = [_heading(1, "中文长文：性能基准文稿")]
    parts.append(
        "这份文稿用来模拟中文写作者的日常体验：段落密集、标点频繁、几乎没有空格，"
        "因此光标定位与换行测量的成本与英文文稿并不相同。" + NL * 2
    )
    section = 0
    length = sum(len(part) for part in parts)
    while length < TARGET_CHARS["T6"]:
        section += 1
        block = [_heading(2, "第 " + str(section) + " 节：写作现场")]
        for _paragraph_index in range(3):
            sentences = [rng.choice(_CHINESE_SENTENCES) for _ in range(5)]
            block.append("".join(sentences) + NL * 2)
        block.append(_heading(3, "第 " + str(section) + ".1 小节：结构"))
        block.append(NL.join("- " + rng.choice(_CHINESE_SENTENCES) for _ in range(4)) + NL * 2)
        block.append("> 引用：" + rng.choice(_CHINESE_SENTENCES) + NL + ">" + NL + "> —— 写作笔记" + NL * 2)
        if section % 3 == 0:
            block.append(
                "| 项目 | 说明 |" + NL + "| --- | --- |" + NL
                + "| 输入 | 按键到文本变更 |" + NL
                + "| 提交 | 文本到 React 状态 |" + NL
                + "| 绘制 | 状态到屏幕像素 |" + NL * 2
            )
        text = "".join(block)
        parts.append(text)
        length += len(text)
    parts.append("结尾段落：确认光标在正文中，而不是停在代码块里。" + NL)
    return "".join(parts)


_GENERATORS = {
    "T0": _t0,
    "T1": _t1,
    "T2": _t2,
    "T3": _t3,
    "T4": _t4,
    "T5": _t5,
    "T6": _t6,
}


# -------------------------------------------------------------------- API ---

def generate(model: str) -> str:
    """Return the Markdown source for a model. Deterministic per model."""
    key = str(model).strip().upper()
    if key not in _GENERATORS:
        raise KeyError("unknown fixture model: " + repr(model) + " (expected one of " + ", ".join(MODELS) + ")")
    return _GENERATORS[key]()


def describe(text: str) -> dict:
    raw = text.encode("utf-8")
    return {
        "chars": len(text),
        "bytes": len(raw),
        "lines": text.count(NL) + 1,
        "headings": sum(1 for line in text.splitlines() if line.startswith("#")),
    }


def write_fixture(model: str, out_dir: Path = DEFAULT_OUT_DIR) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / (model.upper() + ".md")
    path.write_text(generate(model), encoding="utf-8", newline=NL)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate deterministic Inkstone performance fixtures.")
    parser.add_argument("models", nargs="*", default=[], help="models to write (default: all of " + ", ".join(MODELS) + ")")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="directory for <MODEL>.md output")
    args = parser.parse_args(argv)

    selected = [model.upper() for model in (args.models or MODELS)]
    unknown = [model for model in selected if model not in _GENERATORS]
    if unknown:
        parser.error("unknown model(s): " + ", ".join(unknown))

    out_dir = Path(args.out_dir)
    print("writing fixtures to " + str(out_dir))
    print("{:<6}{:>10}{:>10}{:>8}{:>10}".format("model", "chars", "bytes", "lines", "headings"))
    for model in selected:
        text = generate(model)
        path = write_fixture(model, out_dir)
        info = describe(text)
        print("{:<6}{:>10}{:>10}{:>8}{:>10}  {}".format(
            model, info["chars"], info["bytes"], info["lines"], info["headings"], path.name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
