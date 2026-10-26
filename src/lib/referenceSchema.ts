import { commonmark, remarkInlineLinkPlugin, sanitizeLinkHref } from "@milkdown/kit/preset/commonmark";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";

interface HtmlImage {
  url: string;
  alt: string;
  title: string | null;
  ratio: number;
}

function ratioFromElement(image: HTMLImageElement): number {
  const explicit = Number(image.getAttribute("data-ratio"));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const percent = /(?:^|;)\s*width\s*:\s*([\d.]+)%/i.exec(image.getAttribute("style") ?? "");
  if (percent) {
    const ratio = Number(percent[1]) / 100;
    if (Number.isFinite(ratio) && ratio > 0) return ratio;
  }
  return 1;
}

function imageFromHtml(value: string): HtmlImage | null {
  if (!value.includes("data-ratio") && !/width\s*:\s*[\d.]+%/i.test(value)) return null;
  const document = new DOMParser().parseFromString(value, "text/html");
  const image = document.querySelector("img");
  if (!image || document.body.children.length !== 1) return null;
  return {
    url: image.getAttribute("src") ?? "",
    alt: image.getAttribute("alt") ?? "",
    title: image.getAttribute("title"),
    ratio: ratioFromElement(image)
  };
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export const preserveReferencesRemark = $remark("inkstone-preserve-references", () => () => undefined);


export const linkReferenceSchema = $nodeSchema("link-reference", () => ({
  group: "inline",
  inline: true,
  content: "inline*",
  attrs: {
    identifier: { default: "", validate: "string" },
    label: { default: "", validate: "string" },
    referenceType: { default: "full", validate: "string" },
    url: { default: "", validate: "string" },
    title: { default: null, validate: "string|null" }
  },
  parseDOM: [{
    tag: "a[data-reference]",
    getAttrs: (dom: HTMLElement | string) => {
      if (!(dom instanceof HTMLElement)) return false;
      return {
        identifier: dom.getAttribute("data-reference") ?? "",
        label: dom.getAttribute("data-reference-label") ?? "",
        referenceType: dom.getAttribute("data-reference-type") ?? "full",
        url: dom.getAttribute("href") ?? "",
        title: dom.getAttribute("title")
      };
    }
  }],
  toDOM: (node) => ["a", {
    href: sanitizeLinkHref(String(node.attrs.url)),
    title: node.attrs.title,
    "data-reference": node.attrs.identifier,
    "data-reference-label": node.attrs.label,
    "data-reference-type": node.attrs.referenceType
  }, 0],
  parseMarkdown: {
    match: (node) => node.type === "linkReference",
    runner: (state, node, type) => {
      state.openNode(type, {
        identifier: node.identifier ?? "",
        label: node.label ?? "",
        referenceType: node.referenceType ?? "full",
        url: node.url ?? "",
        title: node.title ?? null
      });
      state.next(node.children);
      state.closeNode();
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === "link-reference",
    runner: (state, node) => {
      state.openNode("linkReference", undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label || node.attrs.identifier,
        referenceType: node.attrs.referenceType
      });
      state.next(node.content);
      state.closeNode();
    }
  }
}));

export const imageReferenceSchema = $nodeSchema("image-reference", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: {
    identifier: { default: "", validate: "string" },
    label: { default: "", validate: "string" },
    referenceType: { default: "full", validate: "string" },
    url: { default: "", validate: "string" },
    alt: { default: "", validate: "string" },
    title: { default: null, validate: "string|null" }
  },
  parseDOM: [{
    tag: "img[data-reference]",
    getAttrs: (dom: HTMLElement | string) => {
      if (!(dom instanceof HTMLElement)) return false;
      return {
        identifier: dom.getAttribute("data-reference") ?? "",
        label: dom.getAttribute("data-reference-label") ?? "",
        referenceType: dom.getAttribute("data-reference-type") ?? "full",
        url: dom.getAttribute("src") ?? "",
        alt: dom.getAttribute("alt") ?? "",
        title: dom.getAttribute("title")
      };
    }
  }],
  toDOM: (node) => ["img", {
    src: node.attrs.url,
    alt: node.attrs.alt,
    title: node.attrs.title,
    "data-reference": node.attrs.identifier,
    "data-reference-label": node.attrs.label,
    "data-reference-type": node.attrs.referenceType
  }],
  parseMarkdown: {
    match: (node) => node.type === "imageReference",
    runner: (state, node, type) => {
      state.addNode(type, {
        identifier: node.identifier ?? "",
        label: node.label ?? "",
        referenceType: node.referenceType ?? "full",
        url: node.url ?? "",
        alt: node.alt ?? "",
        title: node.title ?? null
      });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === "image-reference",
    runner: (state, node) => {
      state.addNode("imageReference", undefined, undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label || node.attrs.alt || node.attrs.identifier,
        referenceType: node.attrs.referenceType,
        alt: node.attrs.alt
      });
    }
  }
}));

function definitionText(attrs: { identifier?: unknown; url?: unknown; title?: unknown }): string {
  const title = attrs.title ? " \"" + String(attrs.title).replaceAll("\"", "\\\"") + "\"" : "";
  return "[" + String(attrs.identifier) + "]: " + String(attrs.url) + title;
}

export const definitionSchema = $nodeSchema("definition", () => ({
  group: "block",
  atom: true,
  selectable: true,
  attrs: {
    identifier: { default: "", validate: "string" },
    label: { default: "", validate: "string" },
    url: { default: "", validate: "string" },
    title: { default: null, validate: "string|null" }
  },
  parseDOM: [{
    tag: "div.reference-definition",
    getAttrs: (dom: HTMLElement | string) => {
      if (!(dom instanceof HTMLElement)) return false;
      return {
        identifier: dom.getAttribute("data-identifier") ?? "",
        label: dom.getAttribute("data-reference-label") ?? "",
        url: dom.getAttribute("data-url") ?? "",
        title: dom.getAttribute("data-title")
      };
    }
  }],
  toDOM: (node) => ["div", {
    class: "reference-definition",
    contenteditable: "false",
    "data-identifier": node.attrs.identifier,
    "data-reference-label": node.attrs.label,
    "data-url": node.attrs.url,
    "data-title": node.attrs.title
  }, definitionText(node.attrs)],
  parseMarkdown: {
    match: (node) => node.type === "definition",
    runner: (state, node, type) => {
      state.addNode(type, {
        identifier: node.identifier ?? "",
        label: node.label ?? "",
        url: node.url ?? "",
        title: node.title ?? null
      });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === "definition",
    runner: (state, node) => {
      state.addNode("definition", undefined, undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label || node.attrs.identifier,
        url: node.attrs.url,
        title: node.attrs.title
      });
    }
  }
}));

export function syncReferenceDocument(view: EditorView): boolean {
  const definitions = new Map<string, { url: string; title: string | null }>();
  let hasReferenceWork = false;
  view.state.doc.descendants((node) => {
    if (node.type.name === "image-reference" || node.type.name === "link-reference") hasReferenceWork = true;
    if (node.type.name === "html" && /data-ratio|width\s*:\s*[\d.]+%/i.test(String(node.attrs.value))) hasReferenceWork = true;
    if (node.type.name !== "definition") return;
    const identifier = normalizeIdentifier(String(node.attrs.identifier));
    const url = String(node.attrs.url);
    if (identifier && url) definitions.set(identifier, { url, title: node.attrs.title ?? null });
  });
  if (!hasReferenceWork && definitions.size === 0) return false;
  const imageBlockType = view.state.schema.nodes["image-block"];
  const replacements: { pos: number; attrs: Record<string, unknown> }[] = [];
  const urlUpdates: { pos: number; attrs: Record<string, unknown> }[] = [];
  view.state.doc.descendants((node, pos, parent) => {
    if (node.type.name === "image-reference" || node.type.name === "link-reference") {
      const definition = definitions.get(normalizeIdentifier(String(node.attrs.identifier || node.attrs.label)));
      if (definition && parent?.type.name === "paragraph" && parent.childCount === 1 && node.type.name === "image-reference") {
        replacements.push({
          pos,
          attrs: {
            src: definition.url,
            caption: definition.title ?? "",
            ratio: 1,
            alt: node.attrs.alt,
            legacyRatioAlt: false,
            identifier: node.attrs.identifier,
            label: node.attrs.label,
            referenceType: node.attrs.referenceType
          }
        });
      } else if (definition) {
        urlUpdates.push({ pos, attrs: { ...node.attrs, url: definition.url, title: definition.title } });
      }
      return;
    }
    if (node.type.name === "html" && parent?.type.name === "paragraph" && parent.childCount === 1) {
      const image = imageFromHtml(String(node.attrs.value));
      if (image) {
        replacements.push({
          pos,
          attrs: {
            src: image.url,
            caption: image.title ?? "",
            ratio: image.ratio,
            alt: image.alt,
            legacyRatioAlt: false,
            identifier: "",
            label: "",
            referenceType: "full"
          }
        });
      }
    }
  });
  if (!replacements.length && !urlUpdates.length) return false;
  const tr = view.state.tr;
  for (const update of urlUpdates.sort((a, b) => b.pos - a.pos)) {
    tr.setNodeMarkup(update.pos, undefined, update.attrs);
  }
  if (imageBlockType) {
    for (const replacement of replacements.sort((a, b) => b.pos - a.pos)) {
      const node = view.state.doc.nodeAt(replacement.pos);
      if (!node) continue;
      tr.replaceWith(replacement.pos - 1, replacement.pos + node.nodeSize + 1, imageBlockType.create(replacement.attrs));
    }
  }
  tr.setMeta("addToHistory", false).setMeta("inkstoneReferenceSync", true);
  view.dispatch(tr);
  return true;
}

let installed = false;
export function installReferencePreservingRemark(): void {
  if (installed) return;
  const index = commonmark.findIndex((plugin) => plugin === remarkInlineLinkPlugin.plugin);
  if (index < 0) throw new Error("无法安装引用链接保护：未找到默认转换器");
  // $remark returns both the options context and the plugin; both are required.
  commonmark.splice(index, 1, ...preserveReferencesRemark);
  installed = true;
}

export const referenceSchemas = [linkReferenceSchema, imageReferenceSchema, definitionSchema];
