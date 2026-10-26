export interface FrontmatterParts {
  prefix: string;
  body: string;
  kind: "YAML" | "TOML" | null;
}

/** Split metadata before Milkdown sees it, preserving every source byte. */
export function splitFrontmatter(markdown: string): FrontmatterParts {
  const opening = /^(?:﻿)?(---|\+\+\+)[ \t]*\r?\n/.exec(markdown);
  if (!opening) return { prefix: "", body: markdown, kind: null };
  const marker = opening[1];
  let cursor = opening[0].length;
  while (cursor <= markdown.length) {
    const newline = markdown.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const line = markdown.slice(cursor, lineEnd).replace(/\r$/, "");
    const closes = marker === "+++" ? line.trim() === "+++" : line.trim() === "---" || line.trim() === "...";
    if (closes) {
      const prefixEnd = newline < 0 ? lineEnd : lineEnd + 1;
      return {
        prefix: markdown.slice(0, prefixEnd),
        body: markdown.slice(prefixEnd),
        kind: marker === "+++" ? "TOML" : "YAML"
      };
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return { prefix: "", body: markdown, kind: null };
}

export function restoreFrontmatter(prefix: string, body: string): string {
  if (!prefix) return body;
  if (!body) return prefix;
  return prefix + (prefix.endsWith("\n") ? "" : "\n") + body;
}
