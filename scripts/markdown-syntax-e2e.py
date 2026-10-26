from __future__ import annotations

import argparse
import json
import shutil
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "scripts" / "fixtures" / "markdown-syntax.md"
DOC_NAME = "Markdown 语法实测.md"
INPUT_DOC_NAME = "Markdown 输入实测.md"

COLLECT_JS = r"""() => {
  const root = document.querySelector('.milkdown .ProseMirror');
  if (!root) return null;
  const style = (el) => {
    const cs = getComputedStyle(el);
    return {
      fontStyle: cs.fontStyle,
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      fontSynthesis: cs.fontSynthesis,
      textDecorationLine: cs.textDecorationLine,
      textAlign: cs.textAlign,
      display: cs.display
    };
  };
  const nodes = (selector) => Array.from(root.querySelectorAll(selector)).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: el.textContent || '',
    html: el.outerHTML.slice(0, 1200),
    ...style(el)
  }));
  return {
    text: root.innerText,
    headings: nodes('h1,h2,h3,h4,h5,h6'),
    paragraphs: nodes('p'),
    emphasis: nodes('em'),
    strong: nodes('strong'),
    strikethrough: nodes('del,s'),
    inlineCode: nodes('code'),
    links: Array.from(root.querySelectorAll('a')).map((el) => ({
      text: el.textContent || '', href: el.getAttribute('href') || '', title: el.getAttribute('title') || ''
    })),
    images: Array.from(root.querySelectorAll('img')).map((el) => ({
      alt: el.getAttribute('alt') || '', type: el.getAttribute('data-type') || '',
      title: el.getAttribute('title') || '', className: el.getAttribute('class') || '', styleHeight: el.style.height,
      srcStart: (el.getAttribute('src') || '').slice(0, 80),
      complete: el.complete, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight
    })),
    blockquotes: nodes('blockquote'),
    nestedBlockquoteCount: root.querySelectorAll('blockquote blockquote').length,
    lists: Array.from(root.querySelectorAll('ul,ol')).map((el) => ({
      tag: el.tagName.toLowerCase(), text: el.textContent || '', start: el.tagName === 'OL' ? el.start : null,
      nestedListCount: el.querySelectorAll('ul,ol').length
    })),
    taskItems: Array.from(root.querySelectorAll('li')).filter((el) => (el.textContent || '').includes('任务')).map((el) => {
      const input = el.querySelector('input[type="checkbox"]');
      return {
        text: el.textContent || '', html: el.outerHTML.slice(0, 1600),
        hasCheckbox: Boolean(input || el.querySelector('[data-checked], .label-wrapper')),
        checked: input ? input.checked : el.querySelector('.milkdown-icon.label.checked') ? true : el.querySelector('.milkdown-icon.label.unchecked') ? false : el.getAttribute('data-checked')
      };
    }),
    codeBlocks: Array.from(root.querySelectorAll('.milkdown-code-block, pre')).map((el) => ({
      text: el.textContent || '', html: el.outerHTML.slice(0, 1400)
    })),
    hardbreakCount: root.querySelectorAll('br, span[data-type="hardbreak"]').length,
    hrCount: root.querySelectorAll('hr').length,
    tableCells: Array.from(root.querySelectorAll('table th,table td')).map((el) => ({
      tag: el.tagName.toLowerCase(), text: el.textContent || '', alignAttribute: el.getAttribute('align'),
      styleAttribute: el.getAttribute('style'), ...style(el)
    })),
    katex: nodes('.katex'),
    htmlNodes: nodes('[data-type="html"], [data-test]'),
    documentHtml: root.innerHTML
  };
}"""


def find(nodes: list[dict[str, Any]], token: str) -> dict[str, Any] | None:
    return next((node for node in nodes if token in node.get("text", "")), None)


def wait_for_cdp(port: int, timeout: float = 30) -> None:
    endpoint = f"http://127.0.0.1:{port}/json/version"
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(endpoint, timeout=1) as response:
                json.loads(response.read().decode("utf-8"))
            return
        except Exception as error:
            last_error = error
            time.sleep(0.25)
    raise RuntimeError(f"WebView2 CDP 未就绪: {endpoint}: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description="在真实 Inkstone WebView2 中实测 CommonMark、GFM 与 LaTeX")
    parser.add_argument("--port", type=int, default=9229)
    parser.add_argument("--cdp", action="store_true", help="连接已开启调试端口的真实 WebView2")
    parser.add_argument("--url", default="http://localhost:1420", help="独立 Chromium 模式的应用地址")
    parser.add_argument("--label", default="current", help="报告文件名前缀，例如 baseline 或 fixed")
    args = parser.parse_args()

    out = ROOT.parent / "analysis" / "markdown-syntax"
    workspace = out / "workspace"
    out.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    document = workspace / DOC_NAME
    input_document = workspace / INPUT_DOC_NAME
    shutil.copyfile(FIXTURE, document)
    input_document.write_text("", encoding="utf-8")

    checks: list[dict[str, Any]] = []
    page_errors: list[str] = []
    console_errors: list[str] = []

    def check(group: str, name: str, passed: bool, actual: Any = None) -> None:
        checks.append({"group": group, "name": name, "passed": bool(passed), "actual": actual})

    if args.cdp:
        wait_for_cdp(args.port)
    with sync_playwright() as playwright:
        if args.cdp:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
            pages = [page for context in browser.contexts for page in context.pages]
            if not pages:
                raise RuntimeError("WebView2 中没有可测试页面")
            page = pages[0]
            document_path = str(document)
            input_document_path = str(input_document)
        else:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 960})
            virtual_workspace = "C:/markdown-syntax/workspace"
            document_path = virtual_workspace + "/" + DOC_NAME
            input_document_path = virtual_workspace + "/" + INPUT_DOC_NAME
            mock = (ROOT / "scripts" / "perf" / "tauri_mock.js").read_text(encoding="utf-8")
            seed = (
                "window.__PERF_FS = " + json.dumps({document_path: FIXTURE.read_text(encoding="utf-8"), input_document_path: ""}) + ";"
                "window.__PERF_WORKSPACE = " + json.dumps(virtual_workspace) + ";"
                "window.__PERF_DIALOG = null;"
                "localStorage.setItem('inkstone.workspace.v1', " + json.dumps(virtual_workspace) + ");"
                "localStorage.removeItem('inkstone.drafts.v1');"
            )
            context.add_init_script(seed + chr(10) + mock)
            page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.set_viewport_size({"width": 1440, "height": 960})

        if args.cdp:
            page.evaluate("workspace => localStorage.setItem('inkstone.workspace.v1', workspace)", str(workspace))
            page.reload(wait_until="networkidle")
        else:
            page.goto(args.url, wait_until="networkidle")
        row = page.locator(".tree-row").filter(has_text=DOC_NAME).first
        row.wait_for(timeout=20000)
        row.click()
        try:
            page.wait_for_selector(".milkdown .ProseMirror", timeout=30000)
        except Exception:
            page.screenshot(path=str(out / f"{args.label}-init-failure.png"))
            print("INIT_BODY", page.locator("body").inner_text()[:4000])
            print("INIT_PAGE_ERRORS", page_errors)
            print("INIT_CONSOLE_ERRORS", console_errors)
            raise
        page.wait_for_timeout(1200)

        page.screenshot(path=str(out / f"{args.label}-top.png"))
        for block in page.locator(".milkdown-code-block").all():
            block.scroll_into_view_if_needed()
            page.wait_for_timeout(250)
        page.wait_for_timeout(600)
        snapshot = page.evaluate(COLLECT_JS)
        if snapshot is None:
            raise RuntimeError("所见即所得编辑器未生成 ProseMirror 文档")
        (out / f"{args.label}-dom.html").write_text(snapshot.pop("documentHtml"), encoding="utf-8")
        page.screenshot(path=str(out / f"{args.label}-blocks.png"))

        for level, token in enumerate(("ATX 一级标题", "ATX 二级标题", "ATX 三级标题", "ATX 四级标题", "ATX 五级标题", "ATX 六级标题"), 1):
            check("标题", f"ATX H{level}", any(h["tag"] == f"h{level}" and token in h["text"] for h in snapshot["headings"]), snapshot["headings"])
        check("标题", "Setext H1", any(h["tag"] == "h1" and "Setext 一级标题" in h["text"] for h in snapshot["headings"]))
        check("标题", "Setext H2", any(h["tag"] == "h2" and "Setext 二级标题" in h["text"] for h in snapshot["headings"]))

        soft = find(snapshot["paragraphs"], "软换行前行")
        hard = find(snapshot["paragraphs"], "硬换行前行")
        backslash = find(snapshot["paragraphs"], "反斜杠换行前行")
        check("段落与换行", "普通中英文段落", "Inkstone Markdown syntax smoke test，中英文混排" in snapshot["text"])
        check("段落与换行", "软换行仍在同段", bool(soft and "软换行后行仍属同段" in soft["text"]))
        check("段落与换行", "两个空格硬换行", bool(hard and ("<br" in hard["html"] or 'data-type="hardbreak"' in hard["html"])), hard)
        check("段落与换行", "反斜杠硬换行", bool(backslash and ("<br" in backslash["html"] or 'data-type="hardbreak"' in backslash["html"])), backslash)

        em_star = find(snapshot["emphasis"], "italic-star")
        em_underline = find(snapshot["emphasis"], "italic-underline")
        strong_star = find(snapshot["strong"], "bold-star")
        strong_underline = find(snapshot["strong"], "bold-underline")
        triple_em = find(snapshot["emphasis"], "bold-italic-star")
        triple_strong = find(snapshot["strong"], "bold-italic-star")
        triple_under_em = find(snapshot["emphasis"], "bold-italic-underline")
        triple_under_strong = find(snapshot["strong"], "bold-italic-underline")
        check("强调", "星号斜体生成 em", em_star is not None, snapshot["emphasis"])
        check("强调", "星号斜体计算样式", bool(em_star and em_star["fontStyle"] == "italic"), em_star)
        check("强调", "下划线斜体生成 em", em_underline is not None)
        check("强调", "下划线斜体计算样式", bool(em_underline and em_underline["fontStyle"] == "italic"), em_underline)
        check("强调", "星号粗体", strong_star is not None)
        check("强调", "下划线粗体", strong_underline is not None)
        check("强调", "三星粗斜体同时具备 em/strong", bool(triple_em and triple_strong))
        check("强调", "三下划线粗斜体同时具备 em/strong", bool(triple_under_em and triple_under_strong))
        check("强调", "删除线节点", find(snapshot["strikethrough"], "strike-text") is not None, snapshot["strikethrough"])
        strike = find(snapshot["strikethrough"], "strike-text")
        check("强调", "删除线计算样式", bool(strike and "line-through" in strike["textDecorationLine"]))
        single_tilde = find(snapshot["paragraphs"], "single-tilde")
        check("强调", "单波浪线保持字面不生成删除线", bool(single_tilde and "~single-tilde 不删除~" in single_tilde["text"]) and not any("single-tilde" in node["text"] for node in snapshot["strikethrough"]), {"paragraph": single_tilde, "strikethrough": snapshot["strikethrough"]})
        check("强调", "粗体嵌套斜体", bool(find(snapshot["strong"], "outer-bold") and find(snapshot["emphasis"], "inner-em")))
        check("强调", "斜体嵌套粗体", bool(find(snapshot["emphasis"], "outer-em") and find(snapshot["strong"], "inner-bold")))
        check("强调", "单词内下划线不生成斜体", "snake_case_name" in snapshot["text"] and not any("snake_case_name" in node["text"] for node in snapshot["emphasis"]))
        check("强调", "转义星号和下划线不生成斜体", "*literal-stars 不斜体*" in snapshot["text"] and "_literal-underscore 不斜体_" in snapshot["text"] and not any("literal-stars" in node["text"] or "literal-underscore" in node["text"] for node in snapshot["emphasis"]))

        expected_entities = "& < > " + chr(34) + " " + chr(39) + " 应正确解码"
        check("行内语法", "字符实体解码", expected_entities in snapshot["text"], snapshot["text"][:2000])
        inline_code = find(snapshot["inlineCode"], "inline-code")
        multi_code = find(snapshot["inlineCode"], "code-with-")
        check("行内语法", "行内代码保留 Markdown 字面符号", bool(inline_code and "*not-em* <tag>" in inline_code["text"]), inline_code)
        expected_multi_code = "code-with-" + chr(96) + "backtick"
        check("行内语法", "多反引号代码", bool(multi_code and expected_multi_code in multi_code["text"]), multi_code)

        expected_links = {
            "内联链接": "https://example.com/inline",
            "引用链接": "https://example.com/reference",
            "https://example.com/autolink": "https://example.com/autolink",
            "https://example.com/literal-link": "https://example.com/literal-link",
            "折叠引用": "https://example.com/collapsed"
        }
        for token, href in expected_links.items():
            link = find(snapshot["links"], token)
            check("链接", f"链接解析：{token}", bool(link and link["href"] == href), link)
        image = next((node for node in snapshot["images"] if node["type"] == "image-block"), None)
        check("图片", "data URL 图片节点", bool(image and image["srcStart"].startswith("data:image/png;base64,")), image)
        check("图片", "图片成功解码", bool(image and image["complete"] and image["naturalWidth"] == 1), image)
        check("图片", "Markdown alt 替代文字", bool(image and image["alt"] == "内嵌图片"), image)
        caption = page.locator(".milkdown-image-block .caption-input").first
        check("图片", "Markdown title 图片标题", caption.count() == 1 and caption.input_value() == "像素图片标题", caption.input_value() if caption.count() else None)
        legacy_image = next((node for node in snapshot["images"] if node["alt"] == "旧版缩放图片"), None)
        check("图片", "旧版数字 alt 缩放兼容", bool(legacy_image and legacy_image["styleHeight"] == "0.75px"), legacy_image)
        inline_image = next((node for node in snapshot["images"] if node["alt"] == "行内图像"), None)
        check("图片", "段落内图片 alt/title", bool(inline_image and "image-inline" in inline_image["className"] and inline_image["title"] == "行内图片标题"), inline_image)
        reference_image = next((node for node in snapshot["images"] if node["alt"] == "引用式图片"), None)
        check("图片", "引用式图片解析与 alt", bool(reference_image and reference_image["type"] == "image-block" and reference_image["naturalWidth"] == 1), reference_image)

        check("引用", "引用段落", any("引用第一行" in node["text"] and "引用第二段" in node["text"] for node in snapshot["blockquotes"]))
        check("引用", "嵌套引用", snapshot["nestedBlockquoteCount"] >= 1, snapshot["blockquotes"])
        check("引用", "引用内斜体", find(snapshot["emphasis"], "quote-em") is not None)

        check("列表", "无序列表三种标记", all(token in snapshot["text"] for token in ("无序短横线一", "无序星号项", "无序加号项")))
        check("列表", "嵌套无序列表", any(node["tag"] == "ul" and node["nestedListCount"] > 0 and "无序短横线二" in node["text"] for node in snapshot["lists"]), snapshot["lists"])
        check("列表", "嵌套有序列表", any(node["tag"] == "ol" and node["nestedListCount"] > 0 and "有序列表二" in node["text"] for node in snapshot["lists"]))
        start_four = next((node for node in snapshot["lists"] if node["tag"] == "ol" and "从四开始" in node["text"]), None)
        check("列表", "有序列表起始编号", bool(start_four and start_four["start"] == 4), start_four)
        check("列表", "任务列表两个复选项", len(snapshot["taskItems"]) == 2 and all(item["hasCheckbox"] for item in snapshot["taskItems"]), snapshot["taskItems"])
        check("列表", "任务完成状态", any(item["checked"] in (True, "true", "") and "已完成任务" in item["text"] for item in snapshot["taskItems"]), snapshot["taskItems"])
        check("列表", "任务项内粗体", find(snapshot["strong"], "task-bold") is not None)

        check("代码块", "反引号围栏与语言", any("fenceToken" in block["text"] for block in snapshot["codeBlocks"]), snapshot["codeBlocks"])
        check("代码块", "波浪围栏", any("tilde_fence" in block["text"] for block in snapshot["codeBlocks"]))
        check("代码块", "缩进代码块", any("indented_code" in block["text"] for block in snapshot["codeBlocks"]))
        check("代码块", "代码块内容不误解析斜体", not any("fence-not-em" in node["text"] for node in snapshot["emphasis"]))
        check("分隔线", "三种 thematic break", snapshot["hrCount"] == 3, snapshot["hrCount"])

        headers = [cell for cell in snapshot["tableCells"] if cell["tag"] == "th"]
        body = [cell for cell in snapshot["tableCells"] if cell["tag"] == "td"]
        check("表格", "3 列表头与两行正文", len(headers) == 3 and len(body) == 6, snapshot["tableCells"])
        check("表格", "左对齐", all(cell["textAlign"] == "left" for cell in headers + body if "左" in cell["text"]), snapshot["tableCells"])
        check("表格", "居中对齐", all(cell["textAlign"] == "center" for cell in headers + body if "中" in cell["text"]), snapshot["tableCells"])
        check("表格", "右对齐", all(cell["textAlign"] == "right" for cell in headers + body if "右" in cell["text"]), snapshot["tableCells"])
        check("表格", "表格内粗体", find(snapshot["strong"], "表格粗体") is not None)
        check("表格", "表格内斜体", find(snapshot["emphasis"], "表格斜体") is not None)
        check("表格", "表格内代码", find(snapshot["inlineCode"], "表格代码") is not None)

        check("公式", "行内 KaTeX", any("E=mc" in node["text"].replace(" ", "") or ("E" in node["text"] and "mc" in node["text"]) for node in snapshot["katex"]), snapshot["katex"])
        check("公式", "块级 KaTeX", any("displayMathToken" in node["text"] for node in snapshot["katex"]), snapshot["katex"])
        check("HTML 边界", "行内 HTML 内容保留", "inline-html-text" in snapshot["text"], snapshot["htmlNodes"])
        check("HTML 边界", "块级 HTML 内容保留", "block-html-text" in snapshot["text"], snapshot["htmlNodes"])

        for theme in ("paper", "sepia", "night"):
            for _ in range(4):
                if page.locator(".app").get_attribute("data-theme") == theme:
                    break
                page.locator("button[title^='切换主题']").click()
                page.wait_for_timeout(150)
            themed_style = page.evaluate("""() => {
              const em = Array.from(document.querySelectorAll('.ProseMirror em')).find(el => el.textContent.includes('italic-star'));
              if (!em) return null;
              const cs = getComputedStyle(em);
              return {fontStyle: cs.fontStyle, fontSynthesis: cs.fontSynthesis, fontFamily: cs.fontFamily};
            }""")
            check("主题", f"{theme} 主题斜体", bool(themed_style and themed_style["fontStyle"] == "italic"), themed_style)
        while page.locator(".app").get_attribute("data-theme") != "paper":
            page.locator("button[title^='切换主题']").click()
            page.wait_for_timeout(120)

        emphasis = page.locator(".ProseMirror em").filter(has_text="italic-star").first
        if emphasis.count():
            emphasis.scroll_into_view_if_needed()
            page.wait_for_timeout(200)
        page.screenshot(path=str(out / f"{args.label}-emphasis.png"))

        editor = page.locator(".milkdown .ProseMirror")
        editor.click()
        page.keyboard.press("Control+End")
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        page.keyboard.type("roundtrip-serialization-marker")
        page.wait_for_timeout(900)
        page.locator(".mode-switch button").nth(1).click()
        page.wait_for_selector(".source-editor-shell .cm-editor", timeout=15000)
        page.wait_for_timeout(400)
        page.keyboard.press("Control+S")
        page.wait_for_timeout(900)
        if args.cdp:
            roundtrip = document.read_text(encoding="utf-8")
        else:
            files = page.evaluate("() => window.__perfFs ? window.__perfFs.files : {}")
            roundtrip = files.get(document_path, "")
        (out / f"{args.label}-roundtrip.md").write_text(roundtrip, encoding="utf-8")
        semantic_tokens = (
            "ATX 一级标题", "Setext 一级标题", "italic-star 星斜", "italic-underline 下斜",
            "bold-star 星粗", "bold-underline 下粗", "bold-italic-star 粗斜", "strike-text 删除",
            "outer-bold 内有", "inner-em 斜体", "snake_case_name", "literal-stars 不斜体", "single-tilde 不删除",
            "inline-code *not-em* <tag>", "https://example.com/reference", "内嵌图片",
            "嵌套引用内容", "嵌套无序子项", "嵌套有序子项", "未完成任务", "已完成任务",
            "fenceToken", "tilde_fence", "indented_code", "左对齐表头", "表格斜体",
            "E=mc^2", "displayMathToken", "inline-html-text", "block-html-text",
            "行内图像", "引用式图片", "旧版缩放图片", "roundtrip-serialization-marker"
        )
        missing = [token for token in semantic_tokens if token not in roundtrip]
        check("源码往返", "所见即所得→源码→保存不丢语义内容", not missing, {"missing": missing})
        check("源码往返", "表格语法保留", ":--" in roundtrip.replace(" ", ""), roundtrip[-5000:])
        check("源码往返", "单波浪线不被改写成双波浪线", "~~single-tilde" not in roundtrip and "single-tilde 不删除" in roundtrip, roundtrip[-5000:])
        check("源码往返", "旧版数字比例序列化保留", "![0.75](" in roundtrip, roundtrip[-5000:])

        page.locator(".mode-switch button").nth(0).click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=15000)
        page.wait_for_timeout(800)
        roundtrip_snapshot = page.evaluate(COLLECT_JS)
        roundtrip_em = find(roundtrip_snapshot["emphasis"], "italic-star") if roundtrip_snapshot else None
        check("源码往返", "源码→所见即所得斜体仍正确", bool(roundtrip_em and roundtrip_em["fontStyle"] == "italic"))
        check("源码往返", "源码→所见即所得表格仍存在", bool(roundtrip_snapshot and len(roundtrip_snapshot["tableCells"]) == 9))

        input_row = page.locator(".tree-row").filter(has_text=INPUT_DOC_NAME).first
        input_row.click()
        page.wait_for_selector(".milkdown .ProseMirror", timeout=15000)
        page.wait_for_function("document.querySelectorAll('.milkdown .ProseMirror').length === 1")
        page.locator(".milkdown .ProseMirror").click()
        page.keyboard.type("*键盘斜体*")
        typed_em = page.locator(".ProseMirror em").filter(has_text="键盘斜体").first
        check("现场输入", "星号输入规则生成中文斜体", typed_em.count() == 1 and typed_em.evaluate("el => getComputedStyle(el).fontStyle") == "italic")
        page.keyboard.press("Enter")
        page.keyboard.type("_键盘下斜_")
        typed_under_em = page.locator(".ProseMirror em").filter(has_text="键盘下斜").first
        check("现场输入", "下划线输入规则生成中文斜体", typed_under_em.count() == 1 and typed_under_em.evaluate("el => getComputedStyle(el).fontStyle") == "italic")
        page.keyboard.press("Enter")
        page.keyboard.type("**键盘粗体**")
        check("现场输入", "粗体输入规则", page.locator(".ProseMirror strong").filter(has_text="键盘粗体").count() == 1)
        page.keyboard.press("Enter")
        page.keyboard.type("~~键盘删除~~")
        check("现场输入", "双波浪线输入规则生成删除线", page.locator(".ProseMirror del").filter(has_text="键盘删除").count() == 1)
        page.keyboard.press("Enter")
        page.keyboard.type("~你好~")
        single_input_text = page.locator(".ProseMirror").inner_text()
        check("现场输入", "单波浪线输入保持字面", "~你好~" in single_input_text and page.locator(".ProseMirror del").filter(has_text="你好").count() == 0, single_input_text[-200:])
        page.keyboard.press("Enter")
        page.keyboard.type("~~你好~~")
        check("现场输入", "双波浪线输入生成删除线", page.locator(".ProseMirror del").filter(has_text="你好").count() == 1)
        page.keyboard.press("Enter")
        page.keyboard.type("[输入链接](https://example.com/input \"输入标题\")")
        typed_link = page.locator('.ProseMirror a[href="https://example.com/input"]').first
        check("现场输入", "链接闭合括号即时渲染", typed_link.count() == 1 and typed_link.inner_text() == "输入链接" and typed_link.get_attribute("title") == "输入标题", typed_link.inner_text() if typed_link.count() else None)
        page.keyboard.type(" 后缀")
        check("现场输入", "链接后继续输入不继承链接", typed_link.count() == 1 and "后缀" not in typed_link.inner_text())
        page.keyboard.press("Enter")
        page.keyboard.type("![输入图片](https://example.com/a.png \"图片标题\")")
        typed_image = page.locator(".ProseMirror .milkdown-image-inline img.image-inline").last
        check("现场输入", "图片闭合括号即时渲染", typed_image.count() == 1 and typed_image.get_attribute("alt") == "输入图片" and typed_image.get_attribute("src") == "https://example.com/a.png" and typed_image.get_attribute("title") == "图片标题", typed_image.get_attribute("outerHTML") if typed_image.count() else None)
        page.keyboard.press("Enter")
        page.keyboard.type("<https://example.com/angle>")
        page.keyboard.press("Space")
        angle_link = page.locator('.ProseMirror a[href="https://example.com/angle"]').first
        check("现场输入", "尖括号自动链接", angle_link.count() == 1 and angle_link.inner_text() == "https://example.com/angle", angle_link.inner_text() if angle_link.count() else None)
        page.keyboard.press("Enter")
        page.keyboard.type("https://example.com/bare， ")
        bare_link = page.locator('.ProseMirror a[href="https://example.com/bare"]').first
        check("现场输入", "裸 URL 空格后自动链接", bare_link.count() == 1 and bare_link.inner_text() == "https://example.com/bare", bare_link.inner_text() if bare_link.count() else None)
        page.keyboard.press("Enter")
        page.keyboard.type("[未完成](")
        check("现场输入", "未闭合链接保持源码", page.locator(".ProseMirror a[href]").filter(has_text="未完成").count() == 0 and "[未完成](" in page.locator(".ProseMirror").inner_text())
        page.keyboard.press("Enter")
        page.keyboard.type("[危险链接](javascript:alert(1))")
        check("现场输入", "危险协议链接不渲染", page.locator('.ProseMirror a[href^="javascript:"]').count() == 0 and "[危险链接](javascript:alert(1))" in page.locator(".ProseMirror").inner_text())
        page.keyboard.press("Enter")
        page.keyboard.type("快捷键斜体")
        page.keyboard.press("Shift+Home")
        shortcut_selection = page.evaluate("() => window.getSelection()?.toString() || ''")
        page.keyboard.press("Control+i")
        shortcut_em = page.locator(".ProseMirror em").filter(has_text="快捷键斜体").first
        shortcut_dom = page.locator(".ProseMirror").inner_html()
        (out / f"{args.label}-input-dom.html").write_text(shortcut_dom, encoding="utf-8")
        check("现场输入", "Ctrl+I 切换中文斜体", shortcut_em.count() == 1 and shortcut_em.evaluate("el => getComputedStyle(el).fontStyle") == "italic", {"selection": shortcut_selection, "html": shortcut_dom[-1800:]})
        page.screenshot(path=str(out / f"{args.label}-input.png"))
        page.keyboard.press("Control+s")
        page.wait_for_timeout(900)
        if args.cdp:
            input_saved = input_document.read_text(encoding="utf-8")
        else:
            input_files = page.evaluate("() => window.__perfFs ? window.__perfFs.files : {}")
            input_saved = input_files.get(input_document_path, "")
        check("现场输入", "链接图片输入可保存为 Markdown", "[输入链接](https://example.com/input \"输入标题\")" in input_saved and "![输入图片](https://example.com/a.png \"图片标题\")" in input_saved, input_saved[-2000:])
        check("运行时", "无未捕获页面异常", not page_errors, page_errors)

        report = {
            "label": args.label,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "url": page.url,
            "summary": {
                "total": len(checks),
                "passed": sum(1 for item in checks if item["passed"]),
                "failed": sum(1 for item in checks if not item["passed"])
            },
            "checks": checks,
            "pageErrors": page_errors,
            "consoleErrors": console_errors,
            "snapshot": snapshot
        }
        report_path = out / f"{args.label}-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        for item in checks:
            print(f"[{'PASS' if item['passed'] else 'FAIL'}] {item['group']} / {item['name']}")
            if not item["passed"]:
                actual = json.dumps(item["actual"], ensure_ascii=False)
                print("  ", actual[:800])
        print("SUMMARY", json.dumps(report["summary"], ensure_ascii=False))
        print("REPORT", report_path)
        browser.close()
        return 0 if report["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
