import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";

// Reuse CodeMirror's semantic tag assignments, but let CSS own their colors.
// Unlike a fixed dark theme, this updates immediately for all three surfaces.
const colors: Record<string, string> = {
  "#708": "var(--code-keyword)",
  "#219": "var(--code-number)",
  "#164": "var(--code-number)",
  "#a11": "var(--code-string)",
  "#a50": "var(--code-comment)",
  "#00f": "var(--code-link)",
  "#085": "var(--code-string)",
  "#30a": "var(--code-keyword)",
  "#555": "var(--code-muted)"
};

export const codeTheme = syntaxHighlighting(HighlightStyle.define(
  defaultHighlightStyle.specs.map((style) => ({
    ...style,
    ...(style.color ? { color: colors[style.color] ?? "var(--code-fg)" } : {})
  }))
));
