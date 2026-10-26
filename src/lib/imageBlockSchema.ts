import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import type { EditorView } from "@milkdown/kit/prose/view";

/**
 * Markdown alt text is never a resize channel. The legacy flag remains only
 * for in-memory compatibility; parsed and newly inserted images preserve alt.
 */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resizedImageHtml(src: string, alt: string, caption: string, ratio: number): string {
  const percent = Math.round(ratio * 10000) / 100;
  const title = caption ? ' title="' + escapeAttribute(caption) + '"' : "";
  return '<img src="' + escapeAttribute(src) + '" alt="' + escapeAttribute(alt) + '"' + title +
    ' data-ratio="' + String(Math.round(ratio * 10000) / 10000) + '" style="width:' + String(percent) + '%" />';
}

export const inkstoneImageBlockSchema = imageBlockSchema.extendSchema((prev) => {
  return (ctx) => {
    const base = prev(ctx);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        alt: { default: "", validate: "string" },
        legacyRatioAlt: { default: false, validate: "boolean" },
        identifier: { default: "", validate: "string" },
        label: { default: "", validate: "string" },
        referenceType: { default: "full", validate: "string" }
      },
      parseDOM: [
        {
          tag: 'img[data-type="image-block"]',
          getAttrs: (dom: HTMLElement | string) => {
            if (!(dom instanceof HTMLElement)) return false;
            const ratio = Number(dom.getAttribute("ratio") ?? dom.getAttribute("data-ratio") ?? 1);
            return {
              src: dom.getAttribute("src") || "",
              caption: dom.getAttribute("caption") || "",
              ratio: Number.isFinite(ratio) && ratio !== 0 ? ratio : 1,
              alt: dom.getAttribute("alt") || "",
              legacyRatioAlt: false,
              identifier: dom.getAttribute("data-reference") ?? "",
              label: dom.getAttribute("data-reference-label") ?? "",
              referenceType: dom.getAttribute("data-reference-type") ?? "full"
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
          "data-ratio": node.attrs.ratio,
          alt: node.attrs.legacyRatioAlt ? node.attrs.caption : node.attrs.alt
        }
      ],
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          const rawAlt = ((node.alt as string | null) ?? "").toString();
          const custom = node as unknown as { ratio?: number; identifier?: string; label?: string; referenceType?: string };
          const ratio = Number(custom.ratio ?? 1);
          state.addNode(type, {
            src: node.url as string,
            caption: (node.title as string | null) ?? "",
            ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
            alt: rawAlt,
            legacyRatioAlt: false,
            identifier: custom.identifier ?? "",
            label: custom.label ?? "",
            referenceType: custom.referenceType ?? "full"
          });
        }
      },
      toMarkdown: {
        ...base.toMarkdown,
        runner: (state, node) => {
          const legacy = Boolean(node.attrs.legacyRatioAlt);
          const ratio = Number(node.attrs.ratio);
          state.openNode("paragraph");
          const identifier = String(node.attrs.identifier ?? "");
          if (identifier) {
            state.addNode("imageReference", undefined, undefined, {
              identifier,
              label: String(node.attrs.label || node.attrs.alt || identifier),
              referenceType: String(node.attrs.referenceType || "full"),
              alt: String(node.attrs.alt ?? "")
            });
          } else if (!legacy && Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 0.0001) {
            state.addNode("html", undefined, resizedImageHtml(
              String(node.attrs.src ?? ""),
              String(node.attrs.alt ?? ""),
              String(node.attrs.caption ?? ""),
              ratio
            ));
          } else {
            state.addNode("image", undefined, undefined, {
              title: node.attrs.caption,
              url: node.attrs.src,
              alt: legacy
                ? (Number.isFinite(ratio) ? ratio : 1).toFixed(2)
                : String(node.attrs.alt ?? "")
            });
          }
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
