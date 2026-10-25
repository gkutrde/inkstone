import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from "react";
import type { CSSProperties } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getHTML, replaceAll } from "@milkdown/kit/utils";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";
import { joinPath } from "../lib/path";
import { saveImage } from "../lib/api";
import {
  getTableContext,
  handleTableKeyDown,
  insertTableDirection,
  type TableInsertDirection
} from "../lib/tableEditing";
import {
  markInputStart,
  markTransaction,
  metricsEnabled,
  registerSerializeProbe,
  sinceInput,
  sinceModeSwitch,
  sinceTransaction,
  timeSync
} from "../lib/editorMetrics";

export interface RichEditorHandle {
  getHtml: () => string;
  /** Serializes the live document on demand; null when the editor is not ready. */
  getMarkdown: () => string | null;
  /** The Markdown this instance was mounted with (used to detect stale peers). */
  getInitialMarkdown: () => string;
  /** True when the live doc differs from the last getMarkdown() result. */
  hasPendingChanges: () => boolean;
  replaceContent: (markdown: string) => void;
  focus: () => void;
  scrollToHeading: (index: number) => boolean;
}

interface TableBarState {
  top: number;
  left: number;
  canInsertRowBefore: boolean;
}

interface RichEditorProps {
  initialMarkdown: string;
  workspace: string | null;
  documentPath: string | null;
  onChange: (markdown: string) => void;
  /** Fired after a document change settles; carries the ProseMirror doc size. */
  onDocChanged?: (docSize: number) => void;
  onReady?: () => void;
  onUseSource?: () => void;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  { initialMarkdown, workspace, documentPath, onChange, onDocChanged, onReady, onUseSource },
  ref
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);
  const userInteractedRef = useRef(false);
  const composingRef = useRef(false);
  // Set on every doc-changing transaction, cleared only by a successful
  // getMarkdown(). This is the exact "is there unsaved editor state?" signal;
  // the 200 ms debounce notification is too late for a switch/close race.
  const docChangedSinceSnapshotRef = useRef(false);
  const initialMarkdownRef = useRef(initialMarkdown);
  const onReadyRef = useRef(onReady);
  const onChangeRef = useRef(onChange);
  const onDocChangedRef = useRef(onDocChanged);
  const workspaceRef = useRef(workspace);
  const documentPathRef = useRef(documentPath);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tableBar, setTableBar] = useState<TableBarState | null>(null);
  const [tableHint, setTableHint] = useState<string | null>(null);
  const tableBarRef = useRef<HTMLDivElement>(null);
  const refreshTableBarRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    sinceModeSwitch("mode_switch_chunk_ready");
  }, []);

  onChangeRef.current = onChange;
  onDocChangedRef.current = onDocChanged;
  onReadyRef.current = onReady;
  workspaceRef.current = workspace;
  documentPathRef.current = documentPath;

  useImperativeHandle(ref, () => ({
    getHtml: () => {
      if (!crepeRef.current) return "";
      return crepeRef.current.editor.action(getHTML());
    },
    getInitialMarkdown: () => initialMarkdownRef.current,
    hasPendingChanges: () => docChangedSinceSnapshotRef.current,
    getMarkdown: () => {
      // Never hand back "" for a failed read: callers use null to mean
      // "keep whatever snapshot you already have".
      if (!crepeRef.current || !readyRef.current) return null;
      // A half-converted IME composition must never reach disk or an export.
      if (composingRef.current) return null;
      try {
        const markdown = crepeRef.current.editor.action((ctx) =>
          ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)
        );
        docChangedSinceSnapshotRef.current = false;
        return markdown;
      } catch {
        return null;
      }
    },
    replaceContent: (markdown: string) => {
      if (!crepeRef.current) return;
      // A mode switch must not pile full-document entries into the undo stack:
      // that grew the heap by ~25 MB/min under repeated switches. Rebuilding the
      // state clears the history and lets the old document be collected.
      crepeRef.current.editor.action(replaceAll(markdown, true));
      docChangedSinceSnapshotRef.current = false;
      onChangeRef.current(markdown);
    },
    focus: () => {
      const view = rootRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
      view?.focus();
    },
    scrollToHeading: (index: number) => {
      const headings = rootRef.current?.querySelectorAll(
        ".milkdown h1, .milkdown h2, .milkdown h3, .milkdown h4, .milkdown h5, .milkdown h6"
      );
      const target = headings?.[index] as HTMLElement | undefined;
      if (!target) return false;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    }
  }));

  useEffect(() => {
    const attachProbes = (crepe: Crepe) => {
      // Track doc changes synchronously for the flush decision; metrics are
      // optional on top of that.
      const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
      liveView = view;
      const originalDispatch = view.dispatch.bind(view);
      view.dispatch = (transaction) => {
        if (transaction.docChanged) docChangedSinceSnapshotRef.current = true;
        markTransaction();
        try {
          const result = originalDispatch(transaction);
          scheduleTableBar();
          return result;
        } catch (error) {
          // Crepe's table NodeView schedules a selection-only transaction from a
          // captured state in the next frame. If an undo lands first, that stale
          // selection transaction would otherwise surface as a runtime error.
          if (error instanceof RangeError && error.message.includes("mismatched transaction")) {
            scheduleTableBar();
            return;
          }
          throw error;
        }
      };
      if (!metricsEnabled) return;
      registerSerializeProbe(() => {
        timeSync(
          "markdown_serialize",
          () => {
            crepe.editor.action((ctx) => {
              const doc = ctx.get(editorViewCtx).state.doc;
              ctx.get(serializerCtx)(doc);
            });
          },
          { docSize: view.state.doc.content.size }
        );
      });
    };

    if (!rootRef.current) return;
    let disposed = false;
    const root = rootRef.current;
    root.innerHTML = "";
    setLoading(true);
    setError(null);
    let liveView: EditorView | null = null;
    let tableFrame = 0;
    let tableHintTimer = 0;

    const showTableHint = (message: string) => {
      setTableHint(message);
      if (tableHintTimer) window.clearTimeout(tableHintTimer);
      tableHintTimer = window.setTimeout(() => setTableHint(null), 4200);
    };

    const updateTableBar = () => {
      if (!liveView) {
        setTableBar(null);
        return;
      }
      const context = getTableContext(liveView.state);
      if (!context) {
        setTableBar(null);
        return;
      }
      try {
        const node = liveView.nodeDOM(context.cell.pos);
        const cellElement = node instanceof HTMLElement
          ? node.matches("td, th") ? node : node.closest("td, th")
          : null;
        const tableElement = cellElement?.closest(".milkdown-table-block") as HTMLElement | null;
        if (!cellElement || !tableElement) {
          setTableBar(null);
          return;
        }
        tableElement.querySelectorAll<HTMLButtonElement>('[data-role="row-drag-handle"] .button-group button').forEach((button) => {
          const locked = context.rowIndex === 0;
          button.disabled = locked;
          button.title = locked ? "表头不可删除；可清空文字或删除整表" : "删除当前行";
          button.setAttribute("aria-label", button.title);
        });
        const tableRect = tableElement.getBoundingClientRect();
        const toolbarHeight = 34;
        const toolbarWidth = 232;
        const minTop = 94;
        let top = tableRect.top - toolbarHeight - 10;
        if (top < minTop) top = tableRect.bottom + 10;
        top = Math.max(8, Math.min(top, window.innerHeight - toolbarHeight - 8));
        const left = Math.max(
          8,
          Math.min(tableRect.left + tableRect.width / 2 - toolbarWidth / 2, window.innerWidth - toolbarWidth - 8)
        );
        setTableBar({ top, left, canInsertRowBefore: context.rowIndex > 0 });
      } catch {
        setTableBar(null);
      }
    };

    const scheduleTableBar = () => {
      if (tableFrame) window.cancelAnimationFrame(tableFrame);
      tableFrame = window.requestAnimationFrame(() => {
        tableFrame = 0;
        updateTableBar();
      });
    };
    refreshTableBarRef.current = scheduleTableBar;

    const uploadImage = async (file: File): Promise<string> => {
      const activeWorkspace = workspaceRef.current;
      if (!activeWorkspace) return fileToDataUrl(file);
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      return saveImage(activeWorkspace, file.name, bytes);
    };

    const proxyImage = (url: string): string => {
      if (!url) return url;
      if (/^(https?:|data:|blob:|asset:|file:)/i.test(url)) return url;
      const activeWorkspace = workspaceRef.current;
      if (!activeWorkspace) return url;
      if (!documentPathRef.current) return url;
      return convertFileSrc(joinPath(activeWorkspace, decodeURIComponent(url)));
    };

    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdownRef.current,
      features: {
        [CrepeFeature.AI]: false,
        [CrepeFeature.TopBar]: false
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: "从这里开始写。输入 / 可以打开块菜单。",
          mode: "doc"
        },
        [CrepeFeature.ImageBlock]: {
          onUpload: uploadImage,
          blockOnUpload: uploadImage,
          inlineOnUpload: uploadImage,
          proxyDomURL: proxyImage
        }
      }
    });

    const markInteraction = () => {
      userInteractedRef.current = true;
    };
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      window.setTimeout(() => {
        const editor = crepeRef.current;
        if (!editor) return;
        try {
          const size = editor.editor.action((ctx) => ctx.get(editorViewCtx).state.doc.content.size);
          onDocChangedRef.current?.(size);
        } catch {
          /* editor tore down between compositionend and the timer */
        }
      }, 0);
    };
    root.addEventListener("pointerdown", markInteraction);
    root.addEventListener("keydown", markInteraction);
    root.addEventListener("beforeinput", markInteraction);
    // Capture phase so the timestamp is taken before ProseMirror handles input.
    root.addEventListener("keydown", markInputStart, true);
    root.addEventListener("beforeinput", markInputStart, true);
    root.addEventListener("compositionstart", onCompositionStart, true);
    root.addEventListener("compositionend", onCompositionEnd, true);

    const focusTableBar = () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          tableBarRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        });
      });
    };

    const onTableKeyDown = (event: KeyboardEvent) => {
      if (!liveView || !readyRef.current) return;
      const isMenuKey = (event.key === "F10" && event.shiftKey) || event.key === "ContextMenu";
      if (isMenuKey) {
        if (!getTableContext(liveView.state)) return;
        event.preventDefault();
        event.stopPropagation();
        scheduleTableBar();
        focusTableBar();
        return;
      }
      if (handleTableKeyDown(liveView, event, showTableHint)) {
        event.preventDefault();
        event.stopPropagation();
        scheduleTableBar();
      }
    };
    const onSelectionChange = () => {
      if (liveView) scheduleTableBar();
    };
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".rich-editor-shell")) return;
      setTableBar(null);
    };
    const viewport = root.closest(".editor-viewport");
    root.addEventListener("keydown", onTableKeyDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    viewport?.addEventListener("scroll", scheduleTableBar, { passive: true });
    window.addEventListener("resize", scheduleTableBar);

    crepe.on((listener) => {
      // Deliberately NOT markdownUpdated: that listener makes Milkdown serialize
      // the whole document (300+ ms at 1 MB) on every debounce tick. We only
      // need to know that the doc changed; the snapshot is produced on demand.
      listener.updated((_ctx, doc) => {
        sinceInput("input_to_editor_notify", 1500);
        sinceTransaction("transaction_to_editor_notify");
        if (!readyRef.current || !userInteractedRef.current) return;
        // During an IME composition ProseMirror may expose provisional text;
        // snapshotting it would persist half-converted pinyin. compositionend
        // publishes the settled document instead.
        if (composingRef.current) return;
        onDocChangedRef.current?.(doc.content.size);
      });
    });

    crepeRef.current = crepe;
    crepe
      .create()
      .then(() => {
        if (disposed) return;
        readyRef.current = true;
        attachProbes(crepe);
        setLoading(false);
        scheduleTableBar();
        onReadyRef.current?.();
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      disposed = true;
      readyRef.current = false;
      userInteractedRef.current = false;
      crepeRef.current = null;
      root.removeEventListener("pointerdown", markInteraction);
      root.removeEventListener("keydown", markInteraction);
      root.removeEventListener("beforeinput", markInteraction);
      root.removeEventListener("keydown", markInputStart, true);
      root.removeEventListener("beforeinput", markInputStart, true);
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
      root.removeEventListener("keydown", onTableKeyDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      viewport?.removeEventListener("scroll", scheduleTableBar);
      window.removeEventListener("resize", scheduleTableBar);
      if (tableFrame) window.cancelAnimationFrame(tableFrame);
      if (tableHintTimer) window.clearTimeout(tableHintTimer);
      refreshTableBarRef.current = () => undefined;
      setTableBar(null);
      setTableHint(null);
      registerSerializeProbe(null);
      void crepe.destroy();
    };
  }, [attempt]);

  const applyTableDirection = (direction: TableInsertDirection) => {
    const editor = crepeRef.current;
    if (!editor) return;
    const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
    insertTableDirection(view, direction);
    refreshTableBarRef.current();
  };

  const closeTableBar = (focusEditor = true) => {
    setTableBar(null);
    if (!focusEditor) return;
    const editor = crepeRef.current;
    if (!editor) return;
    const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
    window.requestAnimationFrame(() => view.focus());
  };

  return (
    <div className="rich-editor-shell">
      <div ref={rootRef} className="rich-editor-root" />
      {tableHint && (
        <div className="table-input-hint" role="status" aria-live="polite">
          {tableHint}
        </div>
      )}
      {tableBar && (
        <div
          ref={tableBarRef}
          className="table-quickbar"
          style={{ top: tableBar.top, left: tableBar.left } as CSSProperties}
          role="toolbar"
          aria-label="表格行列操作"
          aria-keyshortcuts="Shift+F10"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeTableBar();
          }}
        >
          <button
            type="button"
            className="table-quickbar-button"
            title={tableBar.canInsertRowBefore ? "在上方插入行" : "表头不能在表格上方插入行"}
            aria-label="在上方插入行"
            disabled={!tableBar.canInsertRowBefore}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyTableDirection("row-before")}
          >
            <ArrowUp size={13} />
            <span>行</span>
          </button>
          <button
            type="button"
            className="table-quickbar-button"
            title="在下方插入行"
            aria-label="在下方插入行"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyTableDirection("row-after")}
          >
            <ArrowDown size={13} />
            <span>行</span>
          </button>
          <span className="table-quickbar-separator" aria-hidden="true" />
          <button
            type="button"
            className="table-quickbar-button"
            title="在左侧插入列"
            aria-label="在左侧插入列"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyTableDirection("col-before")}
          >
            <ArrowLeft size={13} />
            <span>列</span>
          </button>
          <button
            type="button"
            className="table-quickbar-button"
            title="在右侧插入列"
            aria-label="在右侧插入列"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyTableDirection("col-after")}
          >
            <ArrowRight size={13} />
            <span>列</span>
          </button>
        </div>
      )}
      {loading && <div className="editor-loading">正在铺开纸面…</div>}
      {error && (
        <div className="editor-error" role="alert">
          <div className="editor-error-content">
            <h3>编辑器初始化失败</h3>
            <p>{error}</p>
            <div className="editor-error-actions">
              <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
              {onUseSource && <button className="primary-button" onClick={onUseSource}>使用源码模式</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default RichEditor;
