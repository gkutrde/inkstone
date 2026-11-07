import {
  acceptCompletion,
  completeAnyWord,
  completeFromList,
  nextSnippetField,
  prevSnippetField,
  snippetCompletion,
  type Completion,
  type CompletionSource
} from "@codemirror/autocomplete";
import { indentLess, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import { language as activeLanguage, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { ghostCompletionPreview } from "./ghostCompletion";

function snippet(label: string, template: string, detail = "代码片段"): Completion {
  const preview = template
    .replace(/\$\{\d+:([^{}]*)\}/g, "$1")
    .replace(/\$\{\d*\}/g, "");
  return Object.assign(
    snippetCompletion(template, { label, detail, type: "snippet", boost: 20 }),
    { ghostText: preview }
  );
}

function keyword(label: string): Completion {
  return { label, type: "keyword" };
}

const javascript = [
  snippet("function", "function ${1:name}(${2:params}) {\n\t${0}\n}"),
  snippet("const", "const ${1:name} = ${2:value};"),
  snippet("arrow function", "const ${1:name} = (${2:params}) => {\n\t${0}\n};"),
  snippet("if", "if (${1:condition}) {\n\t${0}\n}"),
  snippet("for", "for (let ${1:index} = 0; ${1:index} < ${2:length}; ${1:index}++) {\n\t${0}\n}"),
  snippet("try catch", "try {\n\t${0}\n} catch (${1:error}) {\n\t\n}"),
  snippet("console.log", "console.log(${1:value});"),
  keyword("async"),
  keyword("await"),
  keyword("export"),
  keyword("import")
];

const typescript = [
  ...javascript,
  snippet("interface", "interface ${1:Name} {\n\t${2:property}: ${3:type};\n}"),
  snippet("type", "type ${1:Name} = ${2:type};")
];

const python = [
  snippet("def", "def ${1:name}(${2:params}):\n\t${0}"),
  snippet("class", "class ${1:Name}:\n\t${0}"),
  snippet("if", "if ${1:condition}:\n\t${0}"),
  snippet("for", "for ${1:item} in ${2:items}:\n\t${0}"),
  snippet("while", "while ${1:condition}:\n\t${0}"),
  snippet("with", "with ${1:resource} as ${2:name}:\n\t${0}"),
  snippet("try except", "try:\n\t${0}\nexcept ${1:Exception} as ${2:error}:\n\t"),
  keyword("async"),
  keyword("await"),
  keyword("lambda"),
  keyword("print")
];

const c = [
  snippet("int main", "int main() {\n\t${0}\n\treturn 0;\n}"),
  snippet("return 0", "return 0;"),
  snippet("include", "#include <${1:header}>"),
  snippet("if", "if (${1:condition}) {\n\t${0}\n}"),
  snippet("for", "for (int ${1:i} = 0; ${1:i} < ${2:count}; ${1:i}++) {\n\t${0}\n}"),
  snippet("while", "while (${1:condition}) {\n\t${0}\n}")
];

const cpp = [
  ...c,
  snippet("cout", "std::cout << ${1:value} << std::endl;"),
  snippet("cin", "std::cin >> ${1:value};"),
  snippet("class", "class ${1:Name} {\npublic:\n\t${0}\n};")
];

const html = [
  snippet("html", "<!doctype html>\n<html lang=\"${1:zh-CN}\">\n<head>\n\t<meta charset=\"UTF-8\">\n\t<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n\t<title>${2:Document}</title>\n</head>\n<body>\n\t${0}\n</body>\n</html>"),
  snippet("div", "<div class=\"${1:class}\">${0}</div>"),
  snippet("link", "<a href=\"${1:url}\">${2:text}</a>"),
  snippet("image", "<img src=\"${1:src}\" alt=\"${2:description}\">")
];

const css = [
  snippet("flex", "display: flex;\nalign-items: ${1:center};\njustify-content: ${2:space-between};"),
  snippet("grid", "display: grid;\ngrid-template-columns: ${1:repeat(2, 1fr)};\ngap: ${2:1rem};"),
  snippet("@media", "@media (max-width: ${1:768px}) {\n\t${0}\n}"),
  snippet("variable", "var(--${1:name})")
];

const json = [
  snippet("property", "\"${1:key}\": ${2:value}"),
  snippet("object", "{\n\t\"${1:key}\": ${2:value}\n}"),
  snippet("array", "[\n\t${1:value}\n]")
];

const shell = [
  snippet("shebang", "#!/usr/bin/env ${1:bash}"),
  snippet("if", "if [ ${1:condition} ]; then\n\t${0}\nfi"),
  snippet("for", "for ${1:item} in ${2:items}; do\n\t${0}\ndone"),
  snippet("function", "${1:name}() {\n\t${0}\n}"),
  keyword("echo"),
  keyword("export"),
  keyword("local")
];

const sql = [
  snippet("select", "SELECT ${1:columns}\nFROM ${2:table}\nWHERE ${3:condition};"),
  snippet("insert", "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});"),
  snippet("update", "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};"),
  snippet("join", "SELECT ${1:columns}\nFROM ${2:left}\nJOIN ${3:right} ON ${4:condition};"),
  keyword("CREATE TABLE"),
  keyword("ORDER BY"),
  keyword("GROUP BY")
];

const yaml = [
  snippet("property", "${1:key}: ${2:value}"),
  snippet("list item", "- ${1:value}"),
  snippet("map", "${1:key}:\n\t${2:child}: ${3:value}")
];

const snippets: Record<string, Completion[]> = {
  javascript,
  typescript,
  python,
  c,
  cpp,
  html,
  css,
  json,
  shell,
  sql,
  yaml
};

const aliases: Record<string, string[]> = {
  javascript: ["javascript", "js", "jsx", "mjs", "cjs"],
  typescript: ["typescript", "ts", "tsx", "mts", "cts"],
  python: ["python", "py"],
  c: ["c"],
  cpp: ["cpp", "c++", "cc", "cxx", "hpp", "hxx"],
  html: ["html", "htm"],
  css: ["css"],
  json: ["json", "json5", "jsonld"],
  shell: ["shell", "sh", "bash", "zsh"],
  sql: ["sql", "mysql", "postgresql", "sqlite"],
  yaml: ["yaml", "yml"]
};

function completionGroup(names: string[]): Completion[] | null {
  const normalized = names.map((name) => name.toLowerCase());
  for (const [group, groupAliases] of Object.entries(aliases)) {
    if (normalized.some((name) => groupAliases.includes(name))) return snippets[group];
  }
  return null;
}

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

const completeCommonSnippets: CompletionSource = (context) => {
  if (!isCodePosition(context.state, context.pos)) return null;
  const completions = completionGroup(languageNamesAt(context.state, context.pos));
  return completions ? completeFromList(completions)(context) : null;
};

const completeDocumentWords: CompletionSource = (context) => {
  if (!isCodePosition(context.state, context.pos)) return null;
  return completeAnyWord(context);
};

/** Shared by Crepe code blocks and fenced code in the Markdown source editor. */
export const codeEditingExtensions: Extension[] = [
  ghostCompletionPreview(isCodePosition),
  Prec.high(keymap.of([
    {
      key: "Tab",
      run: (view) => {
        if (!isCodePosition(view.state, view.state.selection.main.head)) return false;
        return acceptCompletion(view) || nextSnippetField(view) || indentMore(view);
      }
    },
    {
      key: "Shift-Tab",
      run: (view) => {
        if (!isCodePosition(view.state, view.state.selection.main.head)) return false;
        return prevSnippetField(view) || indentLess(view);
      }
    },
    {
      key: "Enter",
      run: (view) => {
        if (!isCodePosition(view.state, view.state.selection.main.head)) return false;
        return acceptCompletion(view) || insertNewlineAndIndent(view);
      }
    }
  ])),
  EditorState.languageData.of(() => [
    { autocomplete: completeCommonSnippets },
    { autocomplete: completeDocumentWords }
  ])
];
