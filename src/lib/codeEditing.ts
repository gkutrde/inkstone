import { autocompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import { language as activeLanguage, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";

/** Keep CodeMirror's existing lazy language loading unchanged. */
export const codeLanguages = languages;

function isCodePosition(state: EditorState, pos: number): boolean {
  if (state.facet(activeLanguage)?.name.toLowerCase() !== "markdown") return true;
  const tree = syntaxTree(state);
  let node: typeof tree.topNode | null = tree.resolveInner(pos, -1);
  while (node) {
    if (node.name === "FencedCode") return true;
    node = node.parent;
  }
  return false;
}

function languageNamesAt(state: EditorState, pos: number): string[] {
  const topLanguage = state.facet(activeLanguage)?.name ?? "";
  if (topLanguage.toLowerCase() !== "markdown") return [topLanguage];
  const tree = syntaxTree(state);
  let node: typeof tree.topNode | null = tree.resolveInner(pos, -1);
  while (node && node.name !== "FencedCode") node = node.parent;
  const info = node?.getChild("CodeInfo");
  if (!info) return [];
  const name = state.sliceDoc(info.from, info.to).trim().split(/\s+/)[0] ?? "";
  return [name];
}

const cppLanguageNames = new Set(["cpp", "c++", "cc", "cxx", "hpp", "hxx"]);

function isCppAt(state: EditorState, pos: number): boolean {
  return languageNamesAt(state, pos).some((name) => cppLanguageNames.has(name.toLowerCase()));
}

/**
 * C++ uses Allman braces and four spaces. Only the newline being typed is
 * formatted; existing source and other languages keep their current style.
 */
function insertCppNewline(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const head = selection.main.head;
  if (!isCppAt(state, head)) return false;

  const line = state.doc.lineAt(head);
  const before = state.doc.sliceString(line.from, head);
  const after = state.doc.sliceString(head, line.to);
  const leading = /^[ \t]*/.exec(line.text)?.[0] ?? "";
  const hasAutoClosingBrace = after.startsWith("}");
  const trailingClose = hasAutoClosingBrace ? "\n" + leading + "}" : "";

  if (before.endsWith("{")) {
    const statement = before.slice(0, -1).trimEnd();
    const opening = (statement.trim() ? statement + "\n" : "") + leading + "{";
    const insert = opening + "\n" + leading + "    " + trailingClose;
    const cursor = line.from + opening.length + 1 + leading.length + 4;
    view.dispatch({
      changes: { from: line.from, to: hasAutoClosingBrace ? head + 1 : head, insert },
      selection: { anchor: cursor },
      scrollIntoView: true,
      userEvent: "input"
    });
    return true;
  }

  view.dispatch(state.replaceSelection("\n" + leading), {
    scrollIntoView: true,
    userEvent: "input"
  });
  return true;
}

export const codeEditingExtensions: Extension[] = [
  // Keep closeBrackets(), but remove every completion path: typing popups,
  // explicit Ctrl-Space completion and completion keymap Enter/Tab handling.
  Prec.highest(autocompletion({
    override: [],
    activateOnTyping: false,
    defaultKeymap: false
  })),
  Prec.high(keymap.of([
    {
      key: "Tab",
      run: (view) => {
        if (!isCodePosition(view.state, view.state.selection.main.head)) return false;
        return indentMore(view);
      }
    },
    {
      key: "Shift-Tab",
      run: (view) => {
        if (!isCodePosition(view.state, view.state.selection.main.head)) return false;
        return indentLess(view);
      }
    },
    {
      key: "Enter",
      run: (view) => {
        if (!isCodePosition(view.state, view.state.selection.main.head)) return false;
        return insertCppNewline(view) || insertNewlineAndIndent(view);
      }
    }
  ]))
];
