import type { OutlineItem } from "../types";
import { splitFrontmatter } from "./frontmatter";

interface Fence {
  marker: string;
  length: number;
}

function fenceToken(line: string) {
  const match = /^( {0,3})(\u0060{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return { marker: match[2][0], length: match[2].length, tail: match[3] };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const token = fenceToken(line);
  return Boolean(token && token.marker === fence.marker && token.length >= fence.length && !token.tail.trim());
}

function outlineText(value: string): string {
  return stripInlineMarkdown(value.replace(/[ \t]+#+[ \t]*$/, "").trim());
}

export function extractOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const parts = splitFrontmatter(markdown);
  const lineOffset = parts.prefix ? parts.prefix.split(/\r?\n/).length - 1 : 0;
  const lines = parts.body.split(/\r?\n/);
  let fence: Fence | null = null;
  let setextCandidate: { text: string; line: number } | null = null;

  lines.forEach((line, index) => {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      setextCandidate = null;
      return;
    }
    const token = fenceToken(line);
    if (token && !(token.marker === "\u0060" && token.tail.includes("\u0060"))) {
      fence = { marker: token.marker, length: token.length };
      setextCandidate = null;
      return;
    }

    const atx = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (atx) {
      const text = outlineText(atx[3] ?? "");
      if (text) items.push({ text, level: atx[2].length, line: index + 1 + lineOffset });
      setextCandidate = null;
      return;
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && setextCandidate) {
      const text = outlineText(setextCandidate.text);
      if (text) items.push({ text, level: setext[1][0] === "=" ? 1 : 2, line: setextCandidate.line });
      setextCandidate = null;
      return;
    }

    const trimmed = line.trim();
    const isBlock = /^(?: {0,3})(?:>|[-+*]\s|\d+[.)]\s|#{1,6}(?:\s|$)| {4})/.test(line);
    setextCandidate = trimmed && !isBlock ? { text: trimmed, line: index + 1 + lineOffset } : null;
  });
  return items;
}

export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/(\u0060+)(.*?)\1/g, "$2")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\\([\\\u0060*_~[\]{}()#+\-.!>|])/g, "$1")
    .trim();
}

function withoutFencedCode(markdown: string): string {
  const visible: string[] = [];
  let fence: Fence | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const token = fenceToken(line);
    if (token && !(token.marker === "\u0060" && token.tail.includes("\u0060"))) {
      fence = { marker: token.marker, length: token.length };
      continue;
    }
    visible.push(line);
  }
  return visible.join("\n");
}

export function countText(markdown: string): { words: number; characters: number; minutes: number } {
  const plain = withoutFencedCode(splitFrontmatter(markdown).body)
    .replace(/(\u0060+).*?\1/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/[#>*_~|]/g, " ")
    .replace(/^\s*[-+]\s+/gm, " ");
  const cjk = (plain.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  const characters = plain.replace(/\s/g, "").length;
  const words = cjk + latin;
  return { words, characters, minutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 300)) };
}
