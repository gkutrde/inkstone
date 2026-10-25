import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  cellAround,
  findTable,
  TableMap,
  tableNodeTypes
} from "@milkdown/kit/prose/tables";

export type TableInsertDirection =
  | "row-before"
  | "row-after"
  | "col-before"
  | "col-after";

export interface TableContext {
  table: NonNullable<ReturnType<typeof findTable>>;
  cell: NonNullable<ReturnType<typeof cellAround>>;
  rowIndex: number;
  colIndex: number;
  rowCount: number;
  colCount: number;
}

interface TableBlockSpec {
  header: string[];
  alignments: Array<"left" | "center" | "right">;
  columnCount: number;
  dividerColumnCount: number;
}

function splitPipeRow(text: string): string[] | null {
  if (!text.startsWith("|") || !text.endsWith("|")) return null;
  if (text.includes("\u0060")) return null;
  const body = text.slice(1, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseDivider(text: string): TableBlockSpec["alignments"] | null {
  const cells = splitPipeRow(text);
  if (!cells?.length) return null;
  const alignments: TableBlockSpec["alignments"] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) alignments.push("center");
    else if (cell.endsWith(":")) alignments.push("right");
    else alignments.push("left");
  }
  return alignments;
}

function parseTableBlock(headerText: string, dividerText: string): TableBlockSpec | null {
  const header = splitPipeRow(headerText);
  const alignments = parseDivider(dividerText);
  if (!header?.length || !alignments?.length) return null;
  const columnCount = header.length;
  return {
    header,
    columnCount,
    dividerColumnCount: alignments.length,
    alignments: Array.from({ length: columnCount }, (_, index) => alignments[index] ?? "left")
  };
}

function createTableNode(
  schema: EditorState["schema"],
  headerCells: string[],
  alignments: TableBlockSpec["alignments"]
): ProseNode {
  const types = tableNodeTypes(schema);
  const paragraph = schema.nodes.paragraph;
  const headerRow = schema.nodes.table_header_row;
  if (!types.table || !types.row || !types.cell || !types.header_cell || !headerRow || !paragraph) {
    throw new Error("当前编辑器缺少 Markdown 表格节点");
  }

  const makeCell = (text: string, align: "left" | "center" | "right", isHeader: boolean) => {
    const content = text
      ? paragraph.create(null, schema.text(text))
      : paragraph.create();
    const type = isHeader ? types.header_cell : types.cell;
    return type.create({ alignment: align === "left" ? null : align }, content);
  };

  const header = headerRow.create(
    null,
    headerCells.map((text, index) => makeCell(text, alignments[index] ?? "left", true))
  );
  const body = types.row.create(
    null,
    headerCells.map((text, index) => makeCell("", alignments[index] ?? "left", false))
  );
  return types.table.create(null, [header, body]);
}

export function getTableContext(state: EditorState): TableContext | null {
  const table = findTable(state.selection.$from);
  if (!table) return null;
  const cell = cellAround(state.selection.$from);
  if (!cell) return null;
  try {
    const map = TableMap.get(table.node);
    const rect = map.findCell(cell.pos - table.start);
    return {
      table,
      cell,
      rowIndex: rect.top,
      colIndex: rect.left,
      rowCount: map.height,
      colCount: map.width
    };
  } catch {
    return null;
  }
}

export function createTableFromShortcut(
  view: EditorView,
  onNotice?: (message: string) => void
): boolean {
  const { state } = view;
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || $from.depth < 1) return false;
  const current = $from.parent;
  if (current.type.name !== "paragraph" || selection.from !== $from.end($from.depth)) return false;
  const container = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  if (index < 1) return false;
  const previous = container.child(index - 1);
  if (previous.type.name !== "paragraph") return false;
  if (previous.textContent.includes("\n") || current.textContent.includes("\n")) return false;

  const spec = parseTableBlock(previous.textContent, current.textContent);
  if (!spec) return false;
  if (spec.dividerColumnCount !== spec.columnCount) {
    onNotice?.(`表头有 ${spec.columnCount} 列，分隔行有 ${spec.dividerColumnCount} 列；已按表头列数创建表格。`);
  }

  const currentStart = $from.before($from.depth);
  const replaceFrom = currentStart - previous.nodeSize;
  const replaceTo = currentStart + current.nodeSize;
  let table: ProseNode;
  try {
    table = createTableNode(state.schema, spec.header, spec.alignments);
  } catch {
    return false;
  }

  const tr = state.tr.replaceWith(replaceFrom, replaceTo, table);
  const inserted = tr.doc.nodeAt(replaceFrom);
  if (!inserted) return false;
  const map = TableMap.get(inserted);
  const bodyCell = replaceFrom + 1 + map.positionAt(1, 0, inserted);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(bodyCell + 2, tr.doc.content.size)), 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function moveToCell(
  view: EditorView,
  tableContentStart: number,
  table: ProseNode,
  row: number,
  col: number
): boolean {
  try {
    const map = TableMap.get(table);
    const cellPos = tableContentStart + map.positionAt(row, col, table);
    const target = Math.min(cellPos + 2, view.state.doc.content.size);
    const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target), 1));
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

function executeDirectionWithSelection(
  view: EditorView,
  direction: TableInsertDirection
): boolean {
  const context = getTableContext(view.state);
  if (!context) return false;
  if (direction === "row-before" && context.rowIndex === 0) return false;

  const command =
    direction === "row-before"
      ? addRowBefore
      : direction === "row-after"
        ? addRowAfter
        : direction === "col-before"
          ? addColumnBefore
          : addColumnAfter;
  let dispatched = false;

  command(view.state, (tr) => {
    const tableAfter = findTable(tr.selection.$from);
    if (tableAfter) {
      const mapAfter = TableMap.get(tableAfter.node);
      const targetRow =
        direction === "row-before"
          ? context.rowIndex
          : direction === "row-after"
            ? context.rowIndex + 1
            : context.rowIndex;
      const targetCol =
        direction === "col-before"
          ? context.colIndex
          : direction === "col-after"
            ? context.colIndex + 1
            : context.colIndex;
      if (targetRow >= 0 && targetRow < mapAfter.height && targetCol >= 0 && targetCol < mapAfter.width) {
        const cellPos = tableAfter.start + mapAfter.positionAt(targetRow, targetCol, tableAfter.node);
        const textPos = Math.min(cellPos + 2, tr.doc.content.size);
        try {
          tr.setSelection(TextSelection.near(tr.doc.resolve(textPos), 1));
        } catch {
          /* keep the command's default selection if the target is not addressable */
        }
      }
    }
    dispatched = true;
    view.dispatch(tr.scrollIntoView());
  });

  if (dispatched) {
    window.requestAnimationFrame(() => view.focus());
  }
  return dispatched;
}

export function insertTableDirection(view: EditorView, direction: TableInsertDirection): boolean {
  return executeDirectionWithSelection(view, direction);
}

function addRowAtEnd(view: EditorView): boolean {
  const context = getTableContext(view.state);
  if (!context) return false;
  let dispatched = false;
  addRowAfter(view.state, (tr) => {
    const tableAfter = findTable(tr.selection.$from);
    if (tableAfter) {
      try {
        const mapAfter = TableMap.get(tableAfter.node);
        const cellPos = tableAfter.start + mapAfter.positionAt(mapAfter.height - 1, 0, tableAfter.node);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(cellPos + 2, tr.doc.content.size)), 1));
      } catch {
        /* default command selection remains usable */
      }
    }
    dispatched = true;
    view.dispatch(tr.scrollIntoView());
  });
  if (dispatched) window.requestAnimationFrame(() => view.focus());
  return dispatched;
}

function moveDownOrAddRow(view: EditorView): boolean {
  const context = getTableContext(view.state);
  if (!context) return false;
  const map = TableMap.get(context.table.node);
  if (context.rowIndex + 1 < map.height) {
    const moved = moveToCell(
      view,
      context.table.start,
      context.table.node,
      context.rowIndex + 1,
      context.colIndex
    );
    if (moved) window.requestAnimationFrame(() => view.focus());
    return moved;
  }
  return addRowAtEnd(view);
}

export function exitTable(view: EditorView): boolean {
  const context = getTableContext(view.state);
  if (!context) return false;
  const { state } = view;
  const after = context.table.pos + context.table.node.nodeSize;
  const tr = state.tr;
  const existing = tr.doc.nodeAt(after);
  if (existing?.type.name === "paragraph") {
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1), 1));
  } else {
    const paragraph = state.schema.nodes.paragraph?.create();
    if (!paragraph) return false;
    tr.insert(after, paragraph);
    tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1), 1));
  }
  view.dispatch(tr.scrollIntoView());
  window.requestAnimationFrame(() => view.focus());
  return true;
}

/**
 * Capture-phase handler. Returning true means the event must be prevented
 * before ProseMirror's upstream table keymap sees it.
 */
export function handleTableKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  onNotice?: (message: string) => void
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.key === "Enter") {
    const context = getTableContext(view.state);
    if (!context) {
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        return createTableFromShortcut(view, onNotice);
      }
      return false;
    }
    if (!view.state.selection.empty) return false;
    if (event.ctrlKey || event.metaKey) return exitTable(view);
    if (event.altKey) return false;
    return moveDownOrAddRow(view);
  }
  if (event.key === "Tab" && !event.shiftKey) {
    const context = getTableContext(view.state);
    if (!context) return false;
    if (context.rowIndex + 1 === context.rowCount && context.colIndex + 1 === context.colCount) {
      return addRowAtEnd(view);
    }
  }
  return false;
}
