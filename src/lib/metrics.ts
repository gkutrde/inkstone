import type { OutlineItem } from "../types";

export function extractOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let inFence = false;
  let fenceMarker = "";
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const fence = line.match(/^\s*(\u0060{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      return;
    }
    if (inFence) return;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      items.push({
        text: stripInlineMarkdown(match[2]),
        level: match[1].length,
        line: index + 1
      });
    }
  });
  return items;
}

export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~$]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function countText(markdown: string): { words: number; characters: number; minutes: number } {
  const plain = markdown
    .replace(/\u0060{3}[\s\S]*?\u0060{3}/g, " ")
    .replace(/\u0060[^\u0060]*\u0060/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~]/g, " ");
  const cjk = (plain.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  const characters = markdown.length;
  const words = cjk + latin;
  return { words, characters, minutes: Math.max(1, Math.ceil(words / 300)) };
}
