import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import type { EditorView } from "@milkdown/kit/prose/view";

function numericRatio(alt: string): number | null {
  if (!alt.trim()) return null;
  const ratio = Number(alt);
  return Number.isFinite(ratio) && ratio !== 0 ? ratio : null;
}

/**
 * Crepe stores image resize ratios in Markdown's alt field. Keep that legacy
 * representation only for documents already using it, while preserving normal
 * Markdown alt text as a first-class attribute.
 */
export const inkstoneImageBlockSchema = imageBlockSchema.extendSchema((prev) => {
  return (ctx) => {
    const base = prev(ctx);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        alt: { default: "", validate: "string" },
        legacyRatioAlt: { default: true, validate: "boolean" }
      },
      parseDOM: [
        {
          tag: 'img[data-type="image-block"]',
          getAttrs: (dom: HTMLElement | string) => {
            if (!(dom instanceof HTMLElement)) return false;
            const ratio = Number(dom.getAttribute("ratio") ?? 1);
            return {
              src: dom.getAttribute("src") || "",
              caption: dom.getAttribute("caption") || "",
              ratio: Number.isFinite(ratio) && ratio !== 0 ? ratio : 1,
              alt: dom.getAttribute("alt") || "",
              legacyRatioAlt: false
            };
          }
        }
      ],
      toDOM: (node) => [
        "img",
        {
          "data-type": "image-block",
          src: node.attrs.src,
          caption: node.attrs.caption,
          ratio: node.attrs.ratio,
          alt: node.attrs.legacyRatioAlt ? node.attrs.caption : node.attrs.alt
        }
      ],
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          const rawAlt = ((node.alt as string | null) ?? "").toString();
          const legacyRatio = numericRatio(rawAlt);
          state.addNode(type, {
            src: node.url as string,
            caption: (node.title as string | null) ?? "",
            ratio: legacyRatio ?? 1,
            alt: legacyRatio === null ? rawAlt : "",
            legacyRatioAlt: legacyRatio !== null
          });
        }
      },
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          const legacy = Boolean(node.attrs.legacyRatioAlt);
          const ratio = Number(node.attrs.ratio);
          state.openNode("paragraph");
          state.addNode("image", undefined, undefined, {
            title: node.attrs.caption,
            url: node.attrs.src,
            alt: legacy
              ? (Number.isFinite(ratio) ? ratio : 1).toFixed(2)
              : String(node.attrs.alt ?? "")
          });
          state.closeNode();
        }
      }
    };
  };
});

/** Crepe's Vue node view only knows caption/ratio; mirror the schema's alt into it. */
export function syncImageAltText(view: EditorView): void {
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "image-block") return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const image = dom.matches('img[data-type="image-block"]')
      ? (dom as HTMLImageElement)
      : dom.querySelector<HTMLImageElement>('img[data-type="image-block"]');
    if (!image) return;
    const alt = String(node.attrs.legacyRatioAlt ? node.attrs.caption ?? "" : node.attrs.alt ?? "");
    if (image.alt !== alt) image.alt = alt;
  });
}
