import { marked } from "marked";
import type { ThemeName } from "../types";
import { dirName } from "./path";

interface Palette {
  background: string;
  ink: string;
  muted: string;
  rule: string;
  accent: string;
}

const palettes: Record<ThemeName, Palette> = {
  paper: { background: "#faf8f2", ink: "#20231e", muted: "#77796f", rule: "#ddd8ca", accent: "#a84434" },
  sepia: { background: "#f2e7cf", ink: "#3e3424", muted: "#88745b", rule: "#d8c5a3", accent: "#9b452f" },
  night: { background: "#171c19", ink: "#e7e5dc", muted: "#909a92", rule: "#303a32", accent: "#d2745d" }
};

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { gfm: true, breaks: false }) as string;
}

export function standaloneHtml(title: string, markdown: string, sourcePath: string | null, theme: ThemeName): string {
  const body = markdownToHtml(markdown);
  const palette = palettes[theme];
  const base = sourcePath
    ? '<base href="file:///' + encodeURI(dirName(sourcePath) + "/") + '">'
    : "";
  const css = [
    ":root { color-scheme: " + (theme === "night" ? "dark" : "light") + "; }",
    "body { margin: 0 auto; max-width: 780px; padding: 72px 32px 120px; background: " + palette.background + "; color: " + palette.ink + "; font-family: 'Iowan Old Style', 'Songti SC', 'Source Han Serif SC', Georgia, serif; font-size: 17px; line-height: 1.85; }",
    "h1, h2, h3, h4, h5, h6 { font-family: 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif; line-height: 1.3; margin: 2em 0 .65em; }",
    "h1 { font-size: 2.25em; letter-spacing: -.03em; border-bottom: 1px solid " + palette.rule + "; padding-bottom: .35em; }",
    "h2 { font-size: 1.55em; } h3 { font-size: 1.25em; }",
    "a { color: " + palette.accent + "; text-underline-offset: .18em; }",
    "blockquote { margin: 1.6em 0; padding: .1em 0 .1em 1.2em; border-left: 2px solid " + palette.accent + "; color: " + palette.muted + "; }",
    "code { font-family: 'Cascadia Code', Consolas, monospace; font-size: .88em; background: rgba(127,127,127,.12); padding: .15em .35em; border-radius: 3px; }",
    "pre { background: #18211d; color: #e9e5da; padding: 1.1em 1.25em; overflow: auto; line-height: 1.55; }",
    "pre code { background: none; padding: 0; color: inherit; }",
    "img { max-width: 100%; height: auto; display: block; margin: 1.8em auto; }",
    "table { border-collapse: collapse; width: 100%; margin: 1.6em 0; font-family: 'Microsoft YaHei UI', sans-serif; font-size: .92em; }",
    "th, td { border: 1px solid " + palette.rule + "; padding: .55em .75em; text-align: left; }",
    "th { background: rgba(127,127,127,.08); }",
    "hr { border: 0; border-top: 1px solid " + palette.rule + "; margin: 3em 0; }",
    ".math-block, .katex-display { overflow-x: auto; }",
    "@media print { body { max-width: none; padding: 0; } }"
  ].join("\n");
  return "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" + base + "\n<title>" + escapeHtml(title) + "</title>\n<style>\n" + css + "\n</style>\n</head>\n<body>\n" + body + "\n</body>\n</html>\n";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
