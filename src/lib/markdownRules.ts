import type { Ctx } from "@milkdown/kit/ctx";
import { inputRulesCtx } from "@milkdown/kit/core";
import { linkSchema } from "@milkdown/kit/preset/commonmark";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { $inputRule } from "@milkdown/kit/utils";

const SINGLE_TILDE_RULE_SOURCE = "~{1,2}";
export const DOUBLE_TILDE_INPUT_RULE = /(?<![\w:/])(~~)(.+?)\1(?!\w|\/)$/;

/** GFM otherwise accepts a single tilde; Inkstone requires the unambiguous ~~ form. */
export function configureDoubleTildeOnly(ctx: Ctx): void {
  ctx.update(remarkGFMPlugin.options.key, (previous) => ({ ...(previous ?? {}), singleTilde: false }));
}

/** Milkdown registers its 1–2 tilde rule during setup, so patch that rule in place. */
export function enforceDoubleTildeInputRule(ctx: Ctx): void {
  for (const rule of ctx.get(inputRulesCtx)) {
    const mutable = rule as unknown as { match?: RegExp };
    if (!mutable.match?.source.includes(SINGLE_TILDE_RULE_SOURCE)) continue;
    mutable.match = DOUBLE_TILDE_INPUT_RULE;
  }
}
const LINK_INPUT_RULE =
  /(?<!!)(?<!\\)\[([^\]\n]+)\]\(\s*(<[^>\n]+>|[^\s()\n]+)(?:\s+["']([^"'\n]*)["'])?\s*\)$/;
const AUTOLINK_INPUT_RULE = /<((?:https?:\/\/|mailto:)[^<>\s]+)>$/;
const BARE_URL_INPUT_RULE = /(^|\s)(https?:\/\/[^\s<>]+?)([.,;:!?，。；：！？]*)\s$/;

function safeLinkHref(input: string): string | null {
  const href = input.replace(/^<|>$/g, "").trim();
  if (!href) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto", "tel", "ftp"].includes(scheme)) return null;
  return href;
}

/** Typora renders [label](url) as soon as the closing parenthesis is typed. */
export const linkInputRule = $inputRule((ctx) =>
  new InputRule(LINK_INPUT_RULE, (state, match, start, end) => {
    const label = match[1] ?? "";
    const href = safeLinkHref(match[2] ?? "");
    if (!label || !href) return null;
    const mark = linkSchema.type(ctx).create({
      href,
      title: match[3] || null
    });
    const tr = state.tr.replaceWith(start, end, state.schema.text(label, [mark]));
    tr.setStoredMarks([]);
    return tr;
  })
);

/** Angle autolinks such as <https://example.com> render on the closing angle. */
export const autolinkInputRule = $inputRule((ctx) =>
  new InputRule(AUTOLINK_INPUT_RULE, (state, match, start, end) => {
    const href = match[1] ?? "";
    const safeHref = safeLinkHref(href);
    if (!safeHref) return null;
    const mark = linkSchema.type(ctx).create({ href: safeHref, title: null });
    const tr = state.tr.replaceWith(start, end, state.schema.text(href, [mark]));
    tr.setStoredMarks([]);
    return tr;
  })
);

/** GFM/Typora link a bare URL when the user types the following space. */
export const bareUrlInputRule = $inputRule((ctx) =>
  new InputRule(BARE_URL_INPUT_RULE, (state, match, start, end) => {
    const prefix = match[1] ?? "";
    const href = match[2] ?? "";
    const trailing = match[3] ?? "";
    const safeHref = safeLinkHref(href);
    if (!safeHref) return null;
    const urlStart = start + prefix.length;
    const mark = linkSchema.type(ctx).create({ href: safeHref, title: null });
    const linked = state.schema.text(href, [mark]);
    const space = state.schema.text(trailing + " ");
    const tr = state.tr.replaceWith(urlStart, end, [linked, space]);
    tr.setStoredMarks([]);
    return tr;
  })
);
