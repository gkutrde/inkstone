import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";
import type { Handle } from "mdast-util-to-markdown";
import type { Processor } from "unified";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";

const tableAwareBreak: Handle = (node, parent, state, info) => {
  if (state.stack.includes("tableCell")) return "<br>";
  return defaultHandlers.break(node, parent, state, info);
};

/** Keep ordinary CommonMark breaks unchanged, but persist table breaks as HTML. */
export const tableSoftBreakRemark = $remark("inkstone-table-soft-break", () => {
  return function (this: Processor) {
    const data = this.data();
    const extensions = data.toMarkdownExtensions ?? [];
    data.toMarkdownExtensions = extensions;
    extensions.push({ handlers: { break: tableAwareBreak } });
    return (tree: Root) => {
      visit(tree, "html", (node, index, parent) => {
        if (parent?.type !== "tableCell" || typeof index !== "number") return;
        if (!/^<br\s*\/?\s*>$/i.test(node.value.trim())) return;
        parent.children[index] = { type: "break" };
      });
    };
  };
});
