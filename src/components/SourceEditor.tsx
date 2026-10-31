import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from "react";
import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder as codePlaceholder } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab, redo as historyRedo, undo as historyUndo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import type { ThemeName } from "../types";
import { markInputStart, sinceModeSwitch } from "../lib/editorMetrics";

export interface SourceEditorHandle {
  getMarkdown: () => string | null;
  hasPendingChanges: () => boolean;
  replaceAll: (value: string) => void;
  undo: () => boolean;
  redo: () => boolean;
  findNext: (query: string, backwards?: boolean) => boolean;
  scrollToLine: (line: number) => void;
  focus: () => void;
  getSelection: () => string;
}

interface SourceEditorProps {
  initialMarkdown: string;
  theme: ThemeName;
  fontSize: number;
  onDocChanged: (docSize: number, sampleText?: string) => void;
  onReady?: () => void;
}

function lightTheme(fontSize: number) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--ink)",
        fontSize: fontSize + "px"
      },
      ".cm-scroller": {
        fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
        lineHeight: "1.75",
        overflow: "auto"
      },
      ".cm-content": {
        padding: "48px 0 120px",
        caretColor: "var(--accent)"
      },
      ".cm-line": { padding: "0 16px" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--muted)",
        border: "none"
      },
      ".cm-activeLine": { backgroundColor: "rgba(127, 127, 127, .055)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--accent)" },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "var(--selection) !important"
      },
      ".cm-cursor": { borderLeftColor: "var(--accent)" }
    },
    { dark: false }
  );
}

function nightTheme(fontSize: number) {
  return [
    oneDark,
    EditorView.theme(
      {
        "&": { height: "100%", backgroundColor: "transparent", fontSize: fontSize + "px" },
        ".cm-scroller": {
          fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
          lineHeight: "1.75"
        },
        ".cm-content": { padding: "48px 0 120px" },
        ".cm-gutters": { backgroundColor: "transparent", border: "none" }
      },
      { dark: true }
    )
  ];
}

const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor(
  { initialMarkdown, theme, fontSize, onDocChanged, onReady },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const onDocChangedRef = useRef(onDocChanged);
  const docChangedRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onDocChangedRef.current = onDocChanged;
  onReadyRef.current = onReady;

  useEffect(() => {
    sinceModeSwitch("mode_switch_chunk_ready");
  }, []);

  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      const view = viewRef.current;
      if (!view) return null;
      docChangedRef.current = false;
      return view.state.doc.toString();
    },
    hasPendingChanges: () => docChangedRef.current,
    replaceAll: (value: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value }
      });
    },
    undo: () => {
      const view = viewRef.current;
      if (!view) return false;
      const applied = historyUndo(view);
      view.focus();
      return applied;
    },
    redo: () => {
      const view = viewRef.current;
      if (!view) return false;
      const applied = historyRedo(view);
      view.focus();
      return applied;
    },

    findNext: (query: string, backwards = false) => {
      const view = viewRef.current;
      if (!view || !query) return false;
      const text = view.state.doc.toString();
      const haystack = text.toLocaleLowerCase();
      const needle = query.toLocaleLowerCase();
      const selection = view.state.selection.main;
      let index = backwards
        ? haystack.lastIndexOf(needle, Math.max(0, selection.from - 1))
        : haystack.indexOf(needle, selection.to);
      if (index < 0) index = backwards ? haystack.lastIndexOf(needle) : haystack.indexOf(needle);
      if (index < 0) return false;
      view.dispatch({
        selection: { anchor: index, head: index + query.length },
        scrollIntoView: true
      });
      return true;
    },
    scrollToLine: (line: number) => {
      const view = viewRef.current;
      if (!view) return;
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({
        selection: { anchor: target.from },
        scrollIntoView: true
      });
      view.focus();
    },
    focus: () => viewRef.current?.focus(),
    getSelection: () => {
      const view = viewRef.current;
      if (!view) return "";
      const selection = view.state.selection.main;
      return view.state.sliceDoc(selection.from, selection.to);
    }
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialMarkdown,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          codePlaceholder("直接用 Markdown 书写。"),
          themeCompartment.current.of(theme === "night" ? nightTheme(fontSize) : lightTheme(fontSize)),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            docChangedRef.current = true;
            onDocChangedRef.current(
              update.state.doc.length,
              update.state.doc.sliceString(0, Math.min(4000, update.state.doc.length))
            );
          })
        ]
      }),
      parent: hostRef.current
    });
    viewRef.current = view;
    const markInput = () => markInputStart();
    hostRef.current?.addEventListener("keydown", markInput, true);
    hostRef.current?.addEventListener("beforeinput", markInput, true);
    onReadyRef.current?.();
    return () => {
      hostRef.current?.removeEventListener("keydown", markInput, true);
      hostRef.current?.removeEventListener("beforeinput", markInput, true);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === "night" ? nightTheme(fontSize) : lightTheme(fontSize)
      )
    });
  }, [theme, fontSize]);

  return <div className="source-editor-shell" ref={hostRef} />;
});

export default SourceEditor;
