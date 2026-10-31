import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from "react";
import type { CSSProperties } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { oneDark } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { latex as lazyLatex } from "../lib/lazyLatex";
import { editorViewCtx, remarkCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { insertImageInputRule } from "@milkdown/kit/preset/commonmark";
import { TextSelection } from "@milkdown/kit/prose/state";
import { redo as historyRedo, undo as historyUndo } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getHTML, replaceAll } from "@milkdown/kit/utils";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";
import { documentAssetPath, markdownAssetPath } from "../lib/path";
import { restoreFrontmatter, splitFrontmatter } from "../lib/frontmatter";
import { saveImage } from "../lib/api";
import { inkstoneImageBlockSchema, syncImageAltText } from "../lib/imageBlockSchema";
import { definitionSchema, imageReferenceSchema, installReferencePreservingRemark, linkReferenceSchema, syncReferenceDocument } from "../lib/referenceSchema";
import { createMarkdownSnapshotCache } from "../lib/markdownSnapshot";
import { autolinkInputRule, bareUrlInputRule, configureDoubleTildeOnly, enforceDoubleTildeInputRule, linkInputRule } from "../lib/markdownRules";
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
  record,
  registerSerializeProbe,
  sinceInput,
  sinceModeSwitch,
  sinceTransaction,
  timeSync
} from "../lib/editorMetrics";

export interface RichEditorHandle {
  getHtml: () => string;
  /** Serializes the live document on demand; explicit flushes may include settled IME text. */
  getMarkdown: (allowComposing?: boolean) => string | null;
  /** The Markdown this instance was mounted with (used to detect stale peers). */
  getInitialMarkdown: () => string;
  /** True when the live doc differs from the last getMarkdown() result. */
  hasPendingChanges: () => boolean;
  replaceContent: (markdown: string, resetHistory?: boolean) => void;
  undo: () => boolean;
  redo: () => boolean;
  countMatches: (query: string) => number;
  findNext: (query: string, backwards?: boolean) => boolean;
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
  /** Fired after a document change settles; carries size and a costing sample. */
  onDocChanged?: (docSize: number, sampleText?: string) => void;
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

interface TextMatch { from: number; to: number }

function findTextMatches(view: EditorView, query: string): TextMatch[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const segments: { docPos: number; searchPos: number; length: number }[] = [];
  let searchable = "";
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const value = node.text ?? "";
    const previous = segments[segments.length - 1];
    const contiguous = previous && previous.docPos + previous.length === pos;
    if (!contiguous) searchable += "\u0000";
    segments.push({ docPos: pos, searchPos: searchable.length, length: value.length });
    searchable += value;
  });
  const haystack = searchable.toLocaleLowerCase();
  const matches: TextMatch[] = [];
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    const end = found + needle.length;
    const first = segments.find((segment) => found >= segment.searchPos && found < segment.searchPos + segment.length);
    const last = segments.find((segment) => end - 1 >= segment.searchPos && end - 1 < segment.searchPos + segment.length);
    if (first && last) {
      matches.push({
        from: first.docPos + found - first.searchPos,
        to: last.docPos + end - last.searchPos
      });
    }
    index = found + Math.max(1, needle.length);
  }
  return matches;
}

const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  { initialMarkdown, workspace, documentPath, onChange, onDocChanged, onReady, onUseSource },
  ref
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<CrepeBuilder | null>(null);
  const readyRef = useRef(false);
  const userInteractedRef = useRef(false);
  const composingRef = useRef(false);
  // Set on every doc-changing transaction, cleared only by a successful
  // getMarkdown(). This is the exact "is there unsaved editor state?" signal;
  // the 200 ms debounce notification is too late for a switch/close race.
  const docChangedSinceSnapshotRef = useRef(false);
  const snapshotCacheRef = useRef(createMarkdownSnapshotCache());
  const initialMarkdownRef = useRef(initialMarkdown);
  const initialPartsRef = useRef(splitFrontmatter(initialMarkdown));
  const frontmatterRef = useRef(initialPartsRef.current.prefix);
  const [frontmatterKind, setFrontmatterKind] = useState(initialPartsRef.current.kind);
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
  const liveViewRef = useRef<EditorView | null>(null);
  const refreshTableBarRef = useRef<() => void>(() => undefined);
  const commitTableBar = (next: TableBarState | null) => {
    setTableBar((current) => current === next || (current && next &&
      current.top === next.top && current.left === next.left &&
      current.canInsertRowBefore === next.canInsertRowBefore) ? current : next);
  };

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
    getMarkdown: (allowComposing = false) => {
      // Never hand back "" for a failed read: callers use null to mean
      // "keep whatever snapshot you already have".
      if (!crepeRef.current || !readyRef.current) return null;
      // A half-converted IME composition must never reach disk or an export.
      if (composingRef.current && !allowComposing) return null;
      try {
        const markdown = crepeRef.current.editor.action((ctx) =>
          snapshotCacheRef.current.serialize(ctx.get(schemaCtx), ctx.get(remarkCtx), ctx.get(editorViewCtx).state.doc)
        );
        docChangedSinceSnapshotRef.current = false;
        return restoreFrontmatter(frontmatterRef.current, markdown);
      } catch {
        return null;
      }
    },
    replaceContent: (markdown: string, resetHistory = true) => {
      if (!crepeRef.current) return;
      const parts = splitFrontmatter(markdown);
      frontmatterRef.current = parts.prefix;
      setFrontmatterKind(parts.kind);
      userInteractedRef.current = true;
      // Only cross-editor rebuilds reset history. User edits stay one undoable step.
      crepeRef.current.editor.action(replaceAll(parts.body, resetHistory));
      docChangedSinceSnapshotRef.current = !resetHistory;
      onChangeRef.current(markdown);
    },
    undo: () => {
      const view = liveViewRef.current;
      if (!view) return false;
      userInteractedRef.current = true;
      const applied = historyUndo(view.state, view.dispatch);
      if (applied) refreshTableBarRef.current();
      view.focus();
      return applied;
    },
    redo: () => {
      const view = liveViewRef.current;
      if (!view) return false;
      userInteractedRef.current = true;
      const applied = historyRedo(view.state, view.dispatch);
      if (applied) refreshTableBarRef.current();
      view.focus();
      return applied;
    },
    countMatches: (query: string) => {
      const view = liveViewRef.current;
      return view ? findTextMatches(view, query).length : 0;
    },
    findNext: (query: string, backwards = false) => {
      const view = liveViewRef.current;
      if (!view || !query) return false;
      const matches = findTextMatches(view, query);
      if (!matches.length) return false;
      const selection = view.state.selection;
      const match = backwards
        ? [...matches].reverse().find((item) => item.from < selection.from) ?? matches[matches.length - 1]
        : matches.find((item) => item.from >= selection.to) ?? matches[0];
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView());
      view.focus();
      return true;
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
    const attachProbes = (crepe: CrepeBuilder) => {
      // Track doc changes synchronously for the flush decision; metrics are
      // optional on top of that.
      const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
      liveView = view;
      liveViewRef.current = view;
      const originalDispatch = view.dispatch.bind(view);
      view.dispatch = (transaction) => {
        if (transaction.getMeta("inkstoneReferenceSync")) return originalDispatch(transaction);
        if (transaction.docChanged) docChangedSinceSnapshotRef.current = true;
        markTransaction();
        try {
          const result = originalDispatch(transaction);
          syncReferenceDocument(view);
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
      syncReferenceDocument(view);
      if (!metricsEnabled) return;
      registerSerializeProbe(() => {
        let full = "";
        timeSync(
          "markdown_serialize",
          () => {
            full = crepe.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
          },
          { docSize: view.state.doc.content.size }
        );
        const incremental = timeSync(
          "markdown_incremental",
          () => crepe.editor.action((ctx) =>
            snapshotCacheRef.current.serialize(ctx.get(schemaCtx), ctx.get(remarkCtx), ctx.get(editorViewCtx).state.doc)
          ),
          { docSize: view.state.doc.content.size }
        );
        record("snapshot_parity_mismatch", full === incremental ? 0 : 1, { docSize: view.state.doc.content.size });
      });
    };

    if (!rootRef.current) return;
    let disposed = false;
    const root = rootRef.current;
    root.innerHTML = "";
    setLoading(true);
    setError(null);
    let liveView: EditorView | null = null;
    let imageAltObserver: MutationObserver | null = null;
    let tableFrame = 0;
    let tableHintTimer = 0;
    let prewarmTimer = 0;
    let prewarmIdleId: number | null = null;
    const schedulePrewarm = () => {
      const run = () => {
        prewarmIdleId = null;
        prewarmTimer = 0;
        if (disposed) return;
        const done = crepe.editor.action((ctx) =>
          snapshotCacheRef.current.prewarm(ctx.get(schemaCtx), ctx.get(remarkCtx), ctx.get(editorViewCtx).state.doc, 4)
        );
        if (!done) schedulePrewarm();
      };
      const requestIdle = window.requestIdleCallback;
      if (requestIdle) prewarmIdleId = requestIdle(run, { timeout: 120 });
      else prewarmTimer = window.setTimeout(run, 16);
    };

    const showTableHint = (message: string) => {
      setTableHint(message);
      if (tableHintTimer) window.clearTimeout(tableHintTimer);
      tableHintTimer = window.setTimeout(() => setTableHint(null), 4200);
    };

    const updateTableBar = () => {
      if (!liveView) {
        commitTableBar(null);
        return;
      }
      const context = getTableContext(liveView.state);
      if (!context) {
        commitTableBar(null);
        return;
      }
      try {
        const node = liveView.nodeDOM(context.cell.pos);
        const cellElement = node instanceof HTMLElement
          ? node.matches("td, th") ? node : node.closest("td, th")
          : null;
        const tableElement = cellElement?.closest(".milkdown-table-block") as HTMLElement | null;
        if (!cellElement || !tableElement) {
          commitTableBar(null);
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
        const minTop = Number.parseFloat(getComputedStyle(root).getPropertyValue("--h-chrome")) + 10 || 148;
        let top = tableRect.top - toolbarHeight - 10;
        if (top < minTop) top = tableRect.bottom + 10;
        top = Math.max(8, Math.min(top, window.innerHeight - toolbarHeight - 8));
        const left = Math.max(
          8,
          Math.min(tableRect.left + tableRect.width / 2 - toolbarWidth / 2, window.innerWidth - toolbarWidth - 8)
        );
        commitTableBar({ top, left, canInsertRowBefore: context.rowIndex > 0 });
      } catch {
        commitTableBar(null);
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
      const saved = await saveImage(activeWorkspace, file.name, bytes);
      return markdownAssetPath(documentPathRef.current, activeWorkspace, saved);
    };

    const proxyImage = (url: string): string => {
      if (!url) return url;
      if (/^(https?:|data:|blob:|asset:|file:)/i.test(url)) return url;
      const activeWorkspace = workspaceRef.current;
      if (!activeWorkspace) return url;
      return convertFileSrc(documentAssetPath(documentPathRef.current, activeWorkspace, url));
    };

    installReferencePreservingRemark();
    const crepe = new CrepeBuilder({
      root,
      defaultValue: initialPartsRef.current.body
    })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(imageBlock, {
        onUpload: uploadImage,
        blockOnUpload: uploadImage,
        inlineOnUpload: uploadImage,
        proxyDomURL: proxyImage
      })
      .addFeature(blockEdit)
      .addFeature(placeholder, {
        text: "从这里开始写。输入 / 可以打开块菜单。",
        mode: "doc"
      })
      .addFeature(toolbar)
      .addFeature(codeMirror, { theme: oneDark, languages })
      .addFeature(table)
      .addFeature(lazyLatex);
    crepe.editor.config(configureDoubleTildeOnly);
    // Register after Crepe's image feature so the compatible schema takes precedence.
    crepe.editor.use(inkstoneImageBlockSchema);
    crepe.editor.use(linkReferenceSchema);
    crepe.editor.use(imageReferenceSchema);
    crepe.editor.use(definitionSchema);
    // Typora-style immediate rendering for CommonMark links, images and autolinks.
    crepe.editor.use(linkInputRule);
    crepe.editor.use(autolinkInputRule);
    crepe.editor.use(bareUrlInputRule);
    crepe.editor.use(insertImageInputRule);

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
          const doc = editor.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
          const sample = doc.textBetween(0, Math.min(doc.content.size, 4000), "\n", "\n");
          onDocChangedRef.current?.(doc.content.size, sample);
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
      commitTableBar(null);
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
        const sample = doc.textBetween(0, Math.min(doc.content.size, 4000), "\n", "\n");
        onDocChangedRef.current?.(doc.content.size, sample);
      });
    });

    crepeRef.current = crepe;
    crepe
      .create()
      .then(() => {
        if (disposed) return;
        crepe.editor.action((ctx) => enforceDoubleTildeInputRule(ctx));
        attachProbes(crepe);
        readyRef.current = true;
        imageAltObserver = new MutationObserver((mutations) => {
          const imageChanged = mutations.some((mutation) =>
            [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
              node instanceof HTMLElement && (node.matches('img[data-type="image-block"]') || node.querySelector('img[data-type="image-block"]'))
            )
          );
          if (imageChanged && liveView) syncImageAltText(liveView);
        });
        imageAltObserver.observe(root, { childList: true, subtree: true });
        if (liveView) syncImageAltText(liveView);
        setLoading(false);
        schedulePrewarm();
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
      liveViewRef.current = null;
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
      if (prewarmTimer) window.clearTimeout(prewarmTimer);
      if (prewarmIdleId !== null) window.cancelIdleCallback(prewarmIdleId);
      snapshotCacheRef.current = createMarkdownSnapshotCache();
      imageAltObserver?.disconnect();
      imageAltObserver = null;
      refreshTableBarRef.current = () => undefined;
      commitTableBar(null);
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
    commitTableBar(null);
    if (!focusEditor) return;
    const editor = crepeRef.current;
    if (!editor) return;
    const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
    window.requestAnimationFrame(() => view.focus());
  };

  return (
    <div className="rich-editor-shell">
      {frontmatterKind && (
        <div className="frontmatter-note" role="note">
          <span>{frontmatterKind} 前言已原样保留，富文本模式不会改写元数据。</span>
          {onUseSource && <button type="button" onClick={onUseSource}>在源码中编辑</button>}
        </div>
      )}
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
