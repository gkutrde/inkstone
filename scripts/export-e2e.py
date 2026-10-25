from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent
QA = ROOT.parent / "analysis" / "export-qa"
QA.mkdir(parents=True, exist_ok=True)
image_path = QA / "qa-image.png"

def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

width, height = 360, 200
rows = []
for y in range(height):
    row = bytearray()
    for x in range(width):
        color = (25, 51, 47)
        if 28 <= x < 332 and 28 <= y < 172:
            color = (252, 252, 248)
        if 48 <= x < 92 and 48 <= y < 152:
            color = (182, 93, 71)
        if 116 <= x < 304 and 68 <= y < 76:
            color = (49, 108, 96)
        if 116 <= x < 274 and 100 <= y < 106:
            color = (143, 192, 176)
        row.extend(color)
    rows.append(b"\x00" + bytes(row))
header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
image_path.write_bytes(
    b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", header)
    + png_chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + png_chunk(b"IEND", b"")
)

markdown = """# 导出验收

第一段包含**粗体**、*斜体*、`inline_code()` 和 [项目链接](https://example.com)。

## 列表

- 项目一
- 项目二

3. 第三步
4. 第四步

- [x] 已完成事项
- [ ] 待处理事项

## 表格

| 名称 | 状态 |
| --- | --- |
| 中文内容 | 正常 |
| English | Ready |

## 代码

```rust
fn main() {
    println!("Hello, 世界");
}
```

> 这是一段用于验证样式与中文排版的引用。

---

![验收图片](qa-image.png)
"""
markdown_path = QA / "sample.md"
markdown_path.write_text(markdown, encoding="utf-8")
docx_path = QA / "Inkstone-export.docx"
html_path = QA / "Inkstone-export.html"
markdown_copy_path = QA / "Inkstone-copy.md"

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = browser.contexts[0].pages[0]
    page.wait_for_load_state("networkidle")
    page.reload(wait_until="networkidle")
    if page.locator(".document-toolbar").count() == 0:
        page.locator(".welcome-actions .primary-button").click()
        page.wait_for_selector(".milkdown .ProseMirror")
    page.locator("button[title='导出']").click()
    menu_text = page.locator(".export-menu").inner_text()
    for label in ["Word 文档", "HTML 网页", "Markdown 副本", "打印 / 另存 PDF"]:
        assert label in menu_text
    page.locator("button[title='导出']").click()
    result = page.evaluate("""async (input) => {
      const { buildDocx } = await import('/src/lib/docx-export.ts');
      const { writeExportBytes, writeExport } = await import('/src/lib/api.ts');
      const { standaloneHtml } = await import('/src/lib/markdown.ts');
      const generated = await buildDocx({
        title: '导出验收',
        markdown: input.markdown,
        documentPath: input.documentPath,
        workspace: input.workspace
      });
      await writeExportBytes(input.docxPath, generated.bytes);
      const html = standaloneHtml('导出验收', input.markdown, input.documentPath, 'paper');
      await writeExport(input.htmlPath, html);
      await writeExport(input.markdownCopyPath, input.markdown);
      return { bytes: generated.bytes.length, warnings: generated.warnings, htmlBytes: html.length };
    }""", {
        "markdown": markdown,
        "documentPath": str(markdown_path),
        "workspace": str(QA),
        "docxPath": str(docx_path),
        "htmlPath": str(html_path),
        "markdownCopyPath": str(markdown_copy_path),
    })
    browser.close()

report = {
    "docx": str(docx_path),
    "html": str(html_path),
    "markdownCopy": str(markdown_copy_path),
    "generator": result,
}
assert not result["warnings"], result["warnings"]
assert docx_path.exists() and docx_path.stat().st_size > 1000
(QA / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
