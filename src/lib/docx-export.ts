import { Lexer, type Token, type Tokens } from "marked";
import type { Paragraph, ParagraphChild, Table, TextRun } from "docx";
import { readExportImage } from "./api";
import { dirName, joinPath, normalizeSlashes } from "./path";

type DocxModule = typeof import("docx");
type BlockElement = Paragraph | Table;
type ImageType = "png" | "jpg" | "gif" | "bmp";

interface ExportContext {
  d: DocxModule;
  documentPath: string | null;
  workspace: string | null;
  warnings: string[];
  orderedLists: number;
  orderedStarts: number[];
}

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

export interface DocxBuildResult {
  bytes: number[];
  warnings: string[];
}

export interface DocxBuildInput {
  title: string;
  markdown: string;
  documentPath: string | null;
  workspace: string | null;
}

const HEADING_KEYS = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"] as const;
const TABLE_WIDTH = 9600;
const MAX_IMAGE_WIDTH = 620;
const MAX_IMAGE_HEIGHT = 780;

function cleanText(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function textRun(ctx: ExportContext, text: string, style: RunStyle = {}): TextRun {
  return new ctx.d.TextRun({
    text: cleanText(text),
    bold: style.bold || undefined,
    italics: style.italics || undefined,
    strike: style.strike || undefined,
    color: style.link ? "316C60" : style.code ? "8A5040" : undefined,
    underline: style.link ? {} : undefined,
    size: style.code ? 19 : undefined,
    font: style.code
      ? { ascii: "Cascadia Code", hAnsi: "Cascadia Code", eastAsia: "Microsoft YaHei" }
      : undefined
  });
}

function imageType(href: string): ImageType | null {
  const dataMime = href.match(/^data:image\/(png|jpe?g|gif|bmp)/i)?.[1].toLowerCase();
  const extension = dataMime ?? href.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  if (extension === "png" || extension === "gif" || extension === "bmp") return extension;
  if (extension === "jpg" || extension === "jpeg") return "jpg";
  return null;
}

function imageMime(type: ImageType): string {
  if (type === "jpg") return "image/jpeg";
  return "image/" + type;
}

function decodeDataImage(href: string): Uint8Array | null {
  const match = href.match(/^data:image\/(?:png|jpe?g|gif|bmp);base64,(.+)$/i);
  if (!match) return null;
  try {
    const binary = atob(match[1]);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function localImagePath(href: string, ctx: ExportContext): string | null {
  let value = href.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/\/?/i, "");
    if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    return normalizeSlashes(value);
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return normalizeSlashes(value);
  if (value.startsWith("/")) return normalizeSlashes(value);
  const base = ctx.documentPath ? dirName(ctx.documentPath) : ctx.workspace;
  return base ? joinPath(base, value.split(/[?#]/)[0]) : null;
}

async function measureImage(bytes: Uint8Array, type: ImageType): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: imageMime(type) }));
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const timer = window.setTimeout(() => reject(new Error("image timeout")), 6000);
      image.onload = () => {
        window.clearTimeout(timer);
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("invalid image"));
      };
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageRun(ctx: ExportContext, token: Tokens.Image): Promise<ParagraphChild> {
  const type = imageType(token.href);
  const label = token.text || token.title || "图片";
  if (!type || /^https?:\/\//i.test(token.href)) {
    if (/^https?:\/\//i.test(token.href)) ctx.warnings.push("远程图片未嵌入：" + label);
    else ctx.warnings.push("不支持的图片格式：" + label);
    return textRun(ctx, "[图片：" + label + "]", { italics: true });
  }
  try {
    const data = decodeDataImage(token.href);
    const path = data ? null : localImagePath(token.href, ctx);
    if (!data && !path) throw new Error("unresolved image path");
    const values = data ?? Uint8Array.from(await readExportImage(path!));
    const dimensions = await measureImage(values, type);
    const scale = Math.min(
      1,
      MAX_IMAGE_WIDTH / Math.max(1, dimensions.width),
      MAX_IMAGE_HEIGHT / Math.max(1, dimensions.height)
    );
    return new ctx.d.ImageRun({
      data: values,
      type,
      transformation: {
        width: Math.max(1, Math.round(dimensions.width * scale)),
        height: Math.max(1, Math.round(dimensions.height * scale))
      },
      altText: { name: label, description: label }
    });
  } catch {
    ctx.warnings.push("图片读取失败：" + label);
    return textRun(ctx, "[图片读取失败：" + label + "]", { italics: true });
  }
}

async function inlineRuns(
  ctx: ExportContext,
  tokens: Token[] | undefined,
  style: RunStyle = {}
): Promise<ParagraphChild[]> {
  const children: ParagraphChild[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        children.push(...await inlineRuns(ctx, token.tokens, { ...style, bold: true }));
        break;
      case "em":
        children.push(...await inlineRuns(ctx, token.tokens, { ...style, italics: true }));
        break;
      case "del":
        children.push(...await inlineRuns(ctx, token.tokens, { ...style, strike: true }));
        break;
      case "codespan":
        children.push(textRun(ctx, token.text, { ...style, code: true }));
        break;
      case "link": {
        const linked = await inlineRuns(ctx, token.tokens, { ...style, link: true });
        if (/^(https?:|mailto:)/i.test(token.href)) {
          children.push(new ctx.d.ExternalHyperlink({ children: linked, link: token.href }));
        } else {
          children.push(...linked);
        }
        break;
      }
      case "image":
        children.push(await imageRun(ctx, token as Tokens.Image));
        break;
      case "br":
        children.push(new ctx.d.TextRun({ text: "", break: 1 }));
        break;
      case "text":
        if (token.tokens?.length) children.push(...await inlineRuns(ctx, token.tokens, style));
        else children.push(textRun(ctx, token.text, style));
        break;
      case "escape":
        children.push(textRun(ctx, token.text, style));
        break;
      case "html": {
        const text = token.text.replace(/<[^>]+>/g, "");
        if (text) children.push(textRun(ctx, text, style));
        break;
      }
      default:
        if ("text" in token && typeof token.text === "string") {
          children.push(textRun(ctx, token.text, style));
        }
    }
  }
  return children;
}

async function paragraphWithInline(
  ctx: ExportContext,
  tokens: Token[] | undefined,
  options: Record<string, unknown> = {}
): Promise<Paragraph> {
  const children = await inlineRuns(ctx, tokens);
  return new ctx.d.Paragraph({
    children,
    spacing: { after: 180, line: 330 },
    ...options
  });
}

function codeParagraphs(ctx: ExportContext, code: string): Paragraph[] {
  return code.replace(/\r/g, "").split("\n").map((line) => new ctx.d.Paragraph({
    children: [textRun(ctx, line || " ", { code: true })],
    style: "CodeBlock"
  }));
}

function numberingLevels(ctx: ExportContext, format: "decimal" | "bullet", text: (level: number) => string, start = 1) {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format,
    text: text(level),
    alignment: ctx.d.AlignmentType.LEFT,
    start,
    style: { paragraph: { indent: { left: 480 + level * 360, hanging: 240 } } }
  }));
}

async function listElements(
  ctx: ExportContext,
  token: Tokens.List,
  level = 0
): Promise<BlockElement[]> {
  let reference = "inkstone-bullet";
  if (token.ordered) {
    reference = "inkstone-ordered-" + (++ctx.orderedLists);
    ctx.orderedStarts.push(Number(token.start) || 1);
  }
  const elements: BlockElement[] = [];
  for (const item of token.items) {
    let itemReference = token.ordered ? reference : "inkstone-bullet";
    if (item.task) itemReference = item.checked ? "inkstone-task-checked" : "inkstone-task";
    let first = true;
    for (const child of item.tokens) {
      if (child.type === "checkbox") continue;
      if (child.type === "list") {
        elements.push(...await listElements(ctx, child as Tokens.List, Math.min(8, level + 1)));
        continue;
      }
      if (child.type === "paragraph" || child.type === "text") {
        const inline = child.tokens ?? Lexer.lexInline(child.text);
        const runs = await inlineRuns(ctx, inline);
        if (first && runs.length === 0 && item.tokens.length > 1) continue;
        if (first) {
          elements.push(new ctx.d.Paragraph({
            children: runs,
            numbering: { reference: itemReference, level },
            spacing: { after: 80, line: 320 }
          }));
          first = false;
        } else {
          elements.push(new ctx.d.Paragraph({ children: runs, style: "ListBody" }));
        }
        continue;
      }
      if (first) {
        elements.push(new ctx.d.Paragraph({ numbering: { reference: itemReference, level } }));
        first = false;
      }
      elements.push(...await blockElements(ctx, [child]));
    }
    if (first) elements.push(new ctx.d.Paragraph({ numbering: { reference: itemReference, level } }));
  }
  return elements;
}

function tableElement(ctx: ExportContext, token: Tokens.Table): Promise<Table> {
  const columns = Math.max(1, token.header.length);
  const baseWidth = Math.floor(TABLE_WIDTH / columns);
  const widths = Array.from({ length: columns }, (_, index) =>
    index === columns - 1 ? TABLE_WIDTH - baseWidth * (columns - 1) : baseWidth
  );
  const rows = [token.header, ...token.rows];
  const alignment = (value: "center" | "left" | "right" | null) =>
    value === "center" ? ctx.d.AlignmentType.CENTER : value === "right" ? ctx.d.AlignmentType.RIGHT : ctx.d.AlignmentType.LEFT;

  return Promise.all(rows.map(async (row, rowIndex) => new ctx.d.TableRow({
    tableHeader: rowIndex === 0,
    children: await Promise.all(row.map(async (cell, columnIndex) => new ctx.d.TableCell({
      width: { size: widths[columnIndex] ?? baseWidth, type: ctx.d.WidthType.DXA },
      shading: rowIndex === 0 ? { type: ctx.d.ShadingType.CLEAR, color: "auto", fill: "E8EDE9" } : undefined,
      margins: { top: 80, bottom: 80, left: 110, right: 110 },
      children: [await paragraphWithInline(ctx, cell.tokens, {
        alignment: alignment(cell.align),
        spacing: { after: 40, line: 300 },
        run: rowIndex === 0 ? { bold: true } : undefined
      })]
    })))
  }))).then((tableRows) => new ctx.d.Table({
    columnWidths: widths,
    width: { size: TABLE_WIDTH, type: ctx.d.WidthType.DXA },
    rows: tableRows
  }));
}

async function blockElements(ctx: ExportContext, tokens: Token[]): Promise<BlockElement[]> {
  const elements: BlockElement[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const key = HEADING_KEYS[Math.max(0, Math.min(5, token.depth - 1))];
        elements.push(await paragraphWithInline(ctx, token.tokens, {
          heading: ctx.d.HeadingLevel[key],
          spacing: { before: token.depth === 1 ? 0 : 240, after: 160 }
        }));
        break;
      }
      case "paragraph":
      case "text":
        elements.push(await paragraphWithInline(ctx, token.tokens ?? Lexer.lexInline(token.text)));
        break;
      case "code":
        elements.push(...codeParagraphs(ctx, token.text));
        break;
      case "blockquote": {
        for (const child of token.tokens ?? []) {
          if (child.type === "paragraph" || child.type === "text") {
            elements.push(await paragraphWithInline(ctx, child.tokens ?? Lexer.lexInline(child.text), { style: "BlockQuote" }));
          } else {
            elements.push(...await blockElements(ctx, [child]));
          }
        }
        break;
      }
      case "list":
        elements.push(...await listElements(ctx, token as Tokens.List));
        break;
      case "table":
        elements.push(await tableElement(ctx, token as Tokens.Table));
        break;
      case "hr":
        elements.push(new ctx.d.Paragraph({
          border: { bottom: { color: "BAC7BF", style: ctx.d.BorderStyle.SINGLE, size: 6, space: 1 } },
          spacing: { before: 180, after: 240 }
        }));
        break;
      case "html": {
        const text = token.text.replace(/<[^>]+>/g, "").trim();
        if (text) elements.push(await paragraphWithInline(ctx, Lexer.lexInline(text)));
        break;
      }
      case "space":
      case "def":
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          elements.push(await paragraphWithInline(ctx, Lexer.lexInline(token.text)));
        }
    }
  }
  return elements;
}

export async function buildDocx(input: DocxBuildInput): Promise<DocxBuildResult> {
  const d = await import("docx");
  const ctx: ExportContext = {
    d,
    documentPath: input.documentPath,
    workspace: input.workspace,
    warnings: [],
    orderedLists: 0,
    orderedStarts: []
  };
  const tokens = Lexer.lex(input.markdown, { gfm: true });
  const children = await blockElements(ctx, tokens);
  if (!tokens.some((token) => token.type === "heading" && token.depth === 1)) {
    children.unshift(new d.Paragraph({
      text: input.title.replace(/\.[^.]+$/, ""),
      heading: d.HeadingLevel.TITLE,
      spacing: { after: 260 }
    }));
  }
  if (!children.length) children.push(new d.Paragraph({ text: "" }));

  const numberingConfig = [
    { reference: "inkstone-bullet", levels: numberingLevels(ctx, d.LevelFormat.BULLET, () => "•") },
    { reference: "inkstone-task", levels: numberingLevels(ctx, d.LevelFormat.BULLET, () => "☐") },
    { reference: "inkstone-task-checked", levels: numberingLevels(ctx, d.LevelFormat.BULLET, () => "☑") }
  ];
  for (let index = 1; index <= ctx.orderedLists; index += 1) {
    numberingConfig.push({
      reference: "inkstone-ordered-" + index,
      levels: numberingLevels(ctx, d.LevelFormat.DECIMAL, (level) => "%" + (level + 1) + ".", ctx.orderedStarts[index - 1])
    });
  }

  const document = new d.Document({
    creator: "Inkstone",
    title: input.title.replace(/\.[^.]+$/, ""),
    description: "Exported locally from Inkstone",
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: "Microsoft YaHei", hAnsi: "Microsoft YaHei", eastAsia: "Microsoft YaHei" },
            size: 22,
            color: "1B2B28"
          }
        }
      },
      paragraphStyles: [
        {
          id: "CodeBlock",
          name: "Code Block",
          basedOn: "Normal",
          run: {
            font: { ascii: "Cascadia Code", hAnsi: "Cascadia Code", eastAsia: "Microsoft YaHei" },
            size: 18,
            color: "334842"
          },
          paragraph: {
            spacing: { before: 40, after: 40, line: 280 },
            indent: { left: 240, right: 240 },
            shading: { type: d.ShadingType.CLEAR, color: "auto", fill: "F0F3EF" }
          }
        },
        {
          id: "BlockQuote",
          name: "Block Quote",
          basedOn: "Normal",
          run: { italics: true, color: "5C6C65" },
          paragraph: { indent: { left: 360 }, spacing: { before: 100, after: 180, line: 330 } }
        },
        {
          id: "ListBody",
          name: "List Body",
          basedOn: "Normal",
          paragraph: { indent: { left: 480 }, spacing: { after: 80, line: 320 } }
        }
      ]
    },
    numbering: { config: numberingConfig },
    sections: [{
      properties: { page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      children
    }]
  });
  const buffer = await d.Packer.toArrayBuffer(document);
  return { bytes: Array.from(new Uint8Array(buffer)), warnings: ctx.warnings };
}
