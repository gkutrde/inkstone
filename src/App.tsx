import { lazy, Suspense, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import WindowControls from "./components/WindowControls";
import { syncDesktopGlass } from "./lib/windowGlass";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Command as CommandIcon,
  ChevronRight,
  Download,
  FileCode2,
  FilePlus2,
  FileText,
  FileType2,
  FolderOpen,
  FolderPlus,
  Info,
  Keyboard,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeft,
  PanelRight,
  Printer,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  X
} from "lucide-react";
import Sidebar from "./components/Sidebar";
import Outline from "./components/Outline";
import FindBar from "./components/FindBar";
import type { RichEditorHandle } from "./components/RichEditor";
import SourceEditor from "./components/SourceEditor";
import type { SourceEditorHandle } from "./components/SourceEditor";
import CommandCenter, { type CommandAction } from "./components/CommandCenter";
import ShortcutDialog from "./components/ShortcutDialog";
import PromptDialog, { type PromptRequest } from "./components/PromptDialog";
import type {
  EditorMode,
  FileNode,
  OutlineItem,
  Settings,
  Tab,
  ThemeName
} from "./types";
import {
  createFile,
  createFolder,
  openDefaultAppsSettings,
  pickFolder,
  pickMarkdownFile,
  readTextFile,
  readWorkspace,
  renamePath,
  revealInExplorer,
  saveDocxAs,
  saveHtmlAs,
  saveMarkdownAs,
  takePendingOpen,
  trashPath,
  workspaceWritable,
  writeExport,
  writeExportBytes,
  writeTextFile
} from "./lib/api";
import { extractOutline, countText } from "./lib/metrics";
import { baseName, normalizeSlashes, withMarkdownExtension } from "./lib/path";
import { loadDrafts, persistDrafts } from "./lib/drafts";
import {
  beginCommit,
  endCommit,
  markModeSwitch,
  metricsEnabled,
  record,
  sinceInput,
  sinceModeSwitch,
  timeSync
} from "./lib/editorMetrics";
import { cancelTask, delayForDocSize, estimateDocumentBytes, hasPendingTask, scheduleTask } from "./lib/editorScheduler";
import brandMark from "./assets/brand-mark.svg";

const RichEditor = lazy(() => import("./components/RichEditor"));

const SETTINGS_KEY = "inkstone.settings.v1";
const WORKSPACE_KEY = "inkstone.workspace.v1";
const WORKSPACES_KEY = "inkstone.workspaces.v1";
const RECENT_KEY = "inkstone.recent.v1";

interface RecentEntry {
  path: string;
  name: string;
  at: number;
}

interface ToastState {
  message: string;
  kind: "info" | "success" | "error";
}

const defaultSettings: Settings = {
  theme: "paper",
  fontSize: 17,
  measure: 740,
  showSidebar: typeof window === "undefined" || window.innerWidth > 760,
  showOutline: typeof window === "undefined" || window.innerWidth > 1220,
  autoSave: true,
  reduceTransparency: false
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return defaultSettings;
  }
}

function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, 8);
  } catch {
    return [];
  }
}

function loadRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.path) : [];
  } catch {
    return [];
  }
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);
}

function samePath(left: string | null, right: string | null): boolean {
  if (!left || !right) return left === right;
  return normalizeSlashes(left).toLowerCase() === normalizeSlashes(right).toLowerCase();
}

function isDirty(tab: Tab): boolean {
  return tab.content !== tab.savedContent;
}

function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const needle = query.toLocaleLowerCase();
  const haystack = text.toLocaleLowerCase();
  let count = 0;
  let index = 0;
  while (index >= 0 && index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + Math.max(1, needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function themeName(theme: ThemeName): string {
  if (theme === "night") return "墨夜";
  if (theme === "sepia") return "旧纸";
  return "纸白";
}

function themeIcon(theme: ThemeName) {
  return theme === "night" ? <Sun size={16} /> : <Moon size={16} />;
}

function nextTheme(theme: ThemeName): ThemeName {
  if (theme === "paper") return "sepia";
  if (theme === "sepia") return "night";
  return "paper";
}

function formatRecentDate(timestamp: number): string {
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("zh-CN", sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

function relativeDocumentPath(path: string | null, workspace: string | null): string {
  if (!path) return "";
  const normalizedPath = normalizeSlashes(path);
  if (workspace) {
    const normalizedWorkspace = normalizeSlashes(workspace).replace(/\/+$/, "");
    if (normalizedPath.startsWith(normalizedWorkspace + "/")) {
      return normalizedPath.slice(normalizedWorkspace.length + 1);
    }
  }
  return normalizedPath;
}

export default function App() {
  // Guarded so a normal production bundle never even reads the clock here.
  const renderStartedAt = metricsEnabled ? performance.now() : 0;
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [tabs, setTabs] = useState<Tab[]>(loadDrafts);
  const [activeId, setActiveId] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [recent, setRecent] = useState<RecentEntry[]>(loadRecent);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusRevision, setFindFocusRevision] = useState(0);
  const [editorReadyRevision, setEditorReadyRevision] = useState(0);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [findQuery, setFindQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [exporting, setExporting] = useState(false);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoSavingIds, setAutoSavingIds] = useState<Set<string>>(new Set());
  const [saveConflictIds, setSaveConflictIds] = useState<Set<string>>(new Set());
  // Bumped when the live editor reports a change; lets the dirty marker and the
  // autosave timer react long before the expensive Markdown snapshot exists.
  const [docRevision, setDocRevision] = useState(0);
  const richRef = useRef<RichEditorHandle>(null);
  const sourceRef = useRef<SourceEditorHandle>(null);
  const richReadyRef = useRef(false);
  const sourceReadyRef = useRef(false);
  const focusOnReadyRef = useRef(false);
  const pendingPrintRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  const settingsRef = useRef<Settings>(settings);
  const activeIdRef = useRef<string | null>(activeId);
  const revisionsRef = useRef(new Map<string, number>());
  const contentSnapshotRef = useRef<string | null>(null);
  const editorEpochRef = useRef(0);
  editorEpochRef.current = editorEpoch;
  const findReturnFocusRef = useRef<HTMLElement | null>(null);
  // Latest openDocument for one-shot callbacks (launch file / second instance).
  const openPathHandlerRef = useRef<(path: string) => void>(() => undefined);
  const scrollContextRef = useRef<{ ratio: number } | null>(null);
  const savedRevisionsRef = useRef(new Map<string, number>());
  const saveQueues = useRef(new Map<string, Promise<void>>());
  const openRequestRef = useRef(0);
  const workspaceRequestRef = useRef(0);
  const restoredDrafts = useRef(tabs.some((tab) => tab.path === null && tab.content.length > 0));
  const draftWarningShown = useRef(false);
  tabsRef.current = tabs;
  settingsRef.current = settings;
  activeIdRef.current = activeId;

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const deferredContent = useDeferredValue(activeTab?.content ?? "");
  const outline = useMemo(() => {
    if (!settings.showOutline) return [];
    return timeSync("outline", () => extractOutline(deferredContent), {
      bytes: deferredContent.length
    });
  }, [deferredContent, settings.showOutline]);
  const stats = useMemo(
    () => timeSync("stats", () => countText(deferredContent), { bytes: deferredContent.length }),
    [deferredContent]
  );
  const matchCount = useMemo(
    () => {
      if (!findOpen || !activeTab) return 0;
      if (activeTab.mode === "rich" && richReadyRef.current) {
        return richRef.current?.countMatches(findQuery) ?? 0;
      }
      return timeSync("match_count", () => countMatches(deferredContent, findQuery));
    },
    [deferredContent, findQuery, findOpen, activeTab?.mode, activeId, editorReadyRevision]
  );

  const isTabDirty = (tab: Tab): boolean => {
    const livePending = tab.id === activeIdRef.current && (tab.mode === "rich"
      ? richRef.current?.hasPendingChanges()
      : sourceRef.current?.hasPendingChanges());
    return isDirty(tab) || Boolean(livePending) ||
      (revisionsRef.current.get(tab.id) ?? 0) > (savedRevisionsRef.current.get(tab.id) ?? 0);
  };

  const bumpDocRevision = (id: string) => {
    revisionsRef.current.set(id, (revisionsRef.current.get(id) ?? 0) + 1);
    setDocRevision((value) => value + 1);
  };

  const commitMarkdown = (id: string, markdown: string) => {
    beginCommit();
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id && tab.content !== markdown ? { ...tab, content: markdown } : tab
      )
    );
  };

  // The only synchronous Markdown path left: called on demand.
  // "flush" = a user action needs the newest text; "snapshot" = background refresh.
  const serializeActiveMarkdown = (
    tab: Tab | null,
    reason: "flush" | "snapshot"
  ): string | null => {
    if (!tab || tab.id !== activeIdRef.current) return null;
    const markdown = timeSync(
      reason === "flush" ? "markdown_flush" : "markdown_snapshot",
      () => tab.mode === "rich"
        ? richRef.current?.getMarkdown(reason === "flush") ?? null
        : sourceRef.current?.getMarkdown() ?? null
    );
    if (markdown !== null) contentSnapshotRef.current = markdown;
    record("markdown_bytes", markdown ? markdown.length : -1, { reason, mode: tab.mode });
    return markdown;
  };

  const flushTabContent = (tab: Tab | null): string | null => {
    if (!tab) return null;
    cancelTask("content:" + tab.id);
    // Unchanged since the last snapshot: reuse it instead of paying the full
    // serialization again (saves ~400 ms per redundant flush on 1 MB docs).
    const hasPendingChanges = tab.mode === "rich"
      ? richRef.current?.hasPendingChanges()
      : sourceRef.current?.hasPendingChanges();
    if (tab.id === activeIdRef.current && contentSnapshotRef.current !== null && hasPendingChanges === false) {
      return contentSnapshotRef.current;
    }
    const markdown = serializeActiveMarkdown(tab, "flush");
    if (markdown === null) return null;
    commitMarkdown(tab.id, markdown);
    return markdown;
  };

  const freshContentForTab = (tab: Tab): string => flushTabContent(tab) ?? tab.content;

  // Editor notifications arrive at Milkdown's 200 ms debounce. Small documents
  // are snapshotted immediately; big ones wait for a pause (or an explicit flush).
  const handleDocChanged = (docSize: number, sampleText = "", epoch = editorEpochRef.current) => {
    if (epoch !== editorEpochRef.current) return;
    const id = activeIdRef.current;
    if (!id) return;
    bumpDocRevision(id);
    const estimatedBytes = estimateDocumentBytes(docSize, sampleText);
    record("doc_size", docSize, { estimatedBytes, tier: delayForDocSize(estimatedBytes) });
    const run = () => {
      const tab = tabsRef.current.find((item) => item.id === id) ?? null;
      if (!tab) return;
      const markdown = serializeActiveMarkdown(tab, "snapshot");
      if (markdown === null) return;
      commitMarkdown(id, markdown);
    };
    const delay = delayForDocSize(estimatedBytes);
    if (delay === 0) run();
    else scheduleTask("content:" + id, delay, run);
  };

  const activateTab = (id: string | null) => {
    const currentId = activeIdRef.current;
    if (id === currentId) return;
    if (currentId) {
      const currentTab = tabsRef.current.find((tab) => tab.id === currentId) ?? null;
      flushTabContent(currentTab);
    }
    setActiveId(id);
  };

  // Visibility flips (the dual-instance path) have no mount/ready event, so
  // measure the React commit and the frame that shows the new editor.
  useLayoutEffect(() => {
    if (!activeTab) return;
    sinceModeSwitch("mode_switch_commit");
    const frame = window.requestAnimationFrame(() => sinceModeSwitch("mode_switch_paint"));
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab?.mode]);

  // Input pipeline: the content commit happens after Milkdown's debounce, so
  // these timestamps include that wait on purpose; the point is to see when the
  // editor's text finally reaches React and the next frame.
  useLayoutEffect(() => {
    if (!activeTab) return;
    endCommit();
    sinceInput("input_to_commit", 1500);
    const frame = window.requestAnimationFrame(() => sinceInput("input_to_paint", 1500));
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab?.content]);

  const showToast = (message: string, kind: ToastState["kind"] = "info") => {
    setToast({ message, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "error" ? 6500 : 3200);
  };

  const patchSettings = (patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const rememberRecent = (path: string, name: string) => {
    setRecent((current) => {
      const next = [
        { path, name, at: Date.now() },
        ...current.filter((item) => item.path !== path)
      ].slice(0, 18);
      return next;
    });
  };

  const refreshTree = async (root = workspace) => {
    if (!root) return;
    const request = ++workspaceRequestRef.current;
    try {
      const nodes = await readWorkspace(root);
      if (request === workspaceRequestRef.current) setTree(nodes);
    } catch (error) {
      if (request === workspaceRequestRef.current) showToast(String(error), "error");
    }
  };

  const openWorkspacePath = async (path: string) => {
    const request = ++workspaceRequestRef.current;
    setBusy(true);
    try {
      const nodes = await readWorkspace(path);
      if (request !== workspaceRequestRef.current) return;
      setWorkspace(path);
      setTree(nodes);
      localStorage.setItem(WORKSPACE_KEY, path);
      setRecentWorkspaces((current) => {
        const next = [path, ...current.filter((item) => !samePath(item, path))].slice(0, 8);
        localStorage.setItem(WORKSPACES_KEY, JSON.stringify(next));
        return next;
      });
      showToast("工作区已打开：" + baseName(path), "success");
    } catch (error) {
      if (request === workspaceRequestRef.current) showToast(String(error), "error");
    } finally {
      if (request === workspaceRequestRef.current) setBusy(false);
    }
  };

  const openDocument = async (path: string) => {
    const existing = tabs.find((tab) => samePath(tab.path, path));
    if (existing) {
      activateTab(existing.id);
      window.requestAnimationFrame(() => {
        if (existing.mode === "rich") richRef.current?.focus();
        else sourceRef.current?.focus();
      });
      return;
    }
    const request = ++openRequestRef.current;
    try {
      const document = await readTextFile(path);
      if (request !== openRequestRef.current) return;
      const alreadyOpen = tabsRef.current.find((tab) => samePath(tab.path, document.path));
      if (alreadyOpen) {
        activateTab(alreadyOpen.id);
        return;
      }
      const tab: Tab = {
        id: makeId(),
        path: document.path,
        name: document.name,
        content: document.content,
        savedContent: document.content,
        mode: "rich",
        modifiedMs: document.modifiedMs,
        size: document.size
      };
      focusOnReadyRef.current = true;
      setTabs((current) => [...current, tab]);
      activateTab(tab.id);
      rememberRecent(document.path, document.name);
    } catch (error) {
      if (request === openRequestRef.current) showToast(String(error), "error");
    }
  };

  openPathHandlerRef.current = openDocument;

  const newDocument = () => {
    focusOnReadyRef.current = true;
    const tab: Tab = {
      id: makeId(),
      path: null,
      name: "未命名",
      content: "",
      savedContent: "\u0000",
      mode: "rich"
    };
    setTabs((current) => [...current, tab]);
    activateTab(tab.id);
  };

  const markAutoSaving = (id: string, saving: boolean) => {
    setAutoSavingIds((current) => {
      const next = new Set(current);
      if (saving) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const saveTabNow = async (id: string, saveAs: boolean, automatic: boolean) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab) return;
    if (automatic && (!settingsRef.current.autoSave || !tab.path || !isTabDirty(tab))) return;

    let target = saveAs ? null : tab.path;
    if (!target) {
      let suggestedName = tab.name.trim() || "未命名";
      if (!/\.[A-Za-z0-9]+$/.test(suggestedName)) suggestedName += ".md";
      const defaultPath = workspace
        ? normalizeSlashes(workspace) + "/" + suggestedName
        : suggestedName;
      const chosen = await saveMarkdownAs(defaultPath);
      if (!chosen) return;
      target = withMarkdownExtension(chosen);
    }

    if (tabsRef.current.some((item) => item.id !== id && samePath(item.path, target))) {
      showToast("该文件已在另一个标签中打开，请先关闭那个标签再另存为。", "error");
      return;
    }

    // Capture the revision before serializing: anything typed afterwards stays dirty.
    const revisionAtSave = revisionsRef.current.get(id) ?? 0;
    const content = freshContentForTab(tab);
    if (automatic) markAutoSaving(id, true);
    else setBusy(true);
    try {
      const expected = !saveAs && tab.modifiedMs !== undefined && tab.size !== undefined
        ? { modifiedMs: tab.modifiedMs, size: tab.size }
        : undefined;
      const result = await writeTextFile(target, content, expected);
      const name = baseName(target);
      setTabs((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                path: target,
                name,
                savedContent: content,
                modifiedMs: result.modifiedMs,
                size: result.size
              }
            : item
        )
      );
      savedRevisionsRef.current.set(id, revisionAtSave);
      setSaveConflictIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      rememberRecent(target, name);
      if (workspace && !automatic) await refreshTree();
      if (!automatic) {
        showToast("已保存 · " + new Date(result.modifiedMs).toLocaleTimeString(), "success");
      }
    } catch (error) {
      const message = String(error);
      if (message.startsWith("SAVE_CONFLICT:")) {
        setSaveConflictIds((current) => new Set(current).add(id));
        showToast(
          (automatic ? "自动保存已暂停：" : "") + message.slice("SAVE_CONFLICT:".length),
          "error"
        );
      } else {
        showToast((automatic ? "自动保存失败：" : "") + message, "error");
      }
    } finally {
      if (automatic) markAutoSaving(id, false);
      else setBusy(false);
    }
  };

  const queueSave = (id: string, saveAs = false, automatic = false): Promise<void> => {
    const previous = saveQueues.current.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => saveTabNow(id, saveAs, automatic));
    saveQueues.current.set(id, next);
    return next.finally(() => {
      if (saveQueues.current.get(id) === next) saveQueues.current.delete(id);
    });
  };

  const saveActive = (saveAs = false): Promise<void> => {
    if (!activeTab) return Promise.resolve();
    return queueSave(activeTab.id, saveAs, false);
  };

  const reloadActiveFromDisk = async () => {
    const tab = tabsRef.current.find((item) => item.id === activeIdRef.current);
    if (!tab?.path) return;
    const confirmed = await confirmDialog(
      "重新加载会放弃当前标签中尚未保存的内容，并采用磁盘上的最新版本。",
      { title: "重新加载文稿", kind: "warning", okLabel: "采用磁盘版本", cancelLabel: "保留当前编辑" }
    );
    if (!confirmed) return;
    try {
      cancelTask("content:" + tab.id);
      editorEpochRef.current += 1;
      setEditorEpoch(editorEpochRef.current);
      richRef.current = null;
      sourceRef.current = null;
      const document = await readTextFile(tab.path);
      setTabs((current) => current.map((item) => item.id === tab.id ? {
        ...item,
        content: document.content,
        savedContent: document.content,
        modifiedMs: document.modifiedMs,
        size: document.size
      } : item));
      savedRevisionsRef.current.set(tab.id, revisionsRef.current.get(tab.id) ?? 0);
      setSaveConflictIds((current) => {
        const next = new Set(current);
        next.delete(tab.id);
        return next;
      });
      contentSnapshotRef.current = document.content;
      richReadyRef.current = false;
      sourceReadyRef.current = false;
      showToast("已加载磁盘上的最新版本", "success");
    } catch (error) {
      showToast("重新加载失败：" + String(error), "error");
    }
  };

  const closeTab = async (id: string) => {
    const current = tabsRef.current;
    const tab = current.find((item) => item.id === id);
    if (!tab) return;
    // Snapshot before asking: an edit made inside Milkdown's 200 ms notify
    // window must still count as unsaved work.
    const latest = tab.id === activeIdRef.current ? flushTabContent(tab) : null;
    const dirtyNow = latest !== null
      ? latest !== tab.savedContent || (revisionsRef.current.get(id) ?? 0) > (savedRevisionsRef.current.get(id) ?? 0)
      : isTabDirty(tab);
    if (dirtyNow) {
      const confirmed = await confirmDialog(
        "“" + tab.name + "”还有未保存的更改。关闭后这些更改会丢失。",
        { title: "关闭文稿", kind: "warning", okLabel: "放弃更改", cancelLabel: "继续编辑" }
      );
      if (!confirmed) return;
    }
    cancelTask("content:" + id);
    const index = current.findIndex((item) => item.id === id);
    const next = current.filter((item) => item.id !== id);
    const nextActiveId = activeIdRef.current === id
      ? next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? null
      : activeIdRef.current;
    setTabs(next);
    if (activeIdRef.current === id) setActiveId(nextActiveId);
  };

  const toggleWindowMaximize = () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void getCurrentWindow().toggleMaximize().catch(() => undefined);
  };

  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (!("__TAURI_INTERNALS__" in window) || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, textarea, select, [role='button']")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  const requestWindowClose = async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const current = tabsRef.current.map((tab) => {
      if (tab.id !== activeIdRef.current) return tab;
      const latest = flushTabContent(tab);
      return latest === null ? tab : { ...tab, content: latest };
    });
    const dirty = current.filter((tab) => isTabDirty(tab));
    if (dirty.length > 0) {
      const scope = dirty.length === 1
        ? "“" + dirty[0].name + "”还有未保存的更改。"
        : "有 " + dirty.length + " 个文稿还有未保存的更改。";
      const confirmed = await confirmDialog(
        scope + "关闭窗口后这些更改会丢失。",
        { title: "关闭 Inkstone", kind: "warning", okLabel: "放弃更改并关闭", cancelLabel: "继续编辑" }
      );
      if (!confirmed) return;
    }
    persistDrafts(current);
    try {
      await getCurrentWindow().close();
    } catch (error) {
      showToast("无法关闭窗口：" + String(error), "error");
    }
  };

  const openFileDialog = async () => {
    try {
      const path = await pickMarkdownFile();
      if (path) await openDocument(path);
    } catch (error) {
      showToast("无法打开文件选择器：" + String(error), "error");
    }
  };

  const openFolderDialog = async () => {
    try {
      const path = await pickFolder();
      if (path) await openWorkspacePath(path);
    } catch (error) {
      showToast("无法打开文件夹选择器：" + String(error), "error");
    }
  };

  const askNewWorkspace = async () => {
    try {
      const parent = await pickFolder();
      if (!parent) return;
      setPrompt({
        title: "新建工作区",
        description: "在所选位置创建文件夹，并作为工作区打开。",
        initialValue: "我的文稿",
        confirmLabel: "创建工作区",
        onSubmit: async (value) => {
          const created = await createFolder(parent, value);
          await openWorkspacePath(created);
        }
      });
    } catch (error) {
      showToast("无法新建工作区：" + String(error), "error");
    }
  };

  const updateActiveContent = (markdown: string) => {
    if (!activeId) return;
    beginCommit();
    setTabs((current) =>
      current.map((tab) => (tab.id === activeId ? { ...tab, content: markdown } : tab))
    );
  };

  const setMode = (mode: EditorMode) => {
    if (!activeId) return;
    if (activeTab?.mode === mode) return;
    markModeSwitch();
    captureScrollContext();
    // A-mode switch: flush, then let the other editor mount from this snapshot.
    const markdown = flushTabContent(activeTab);
    focusOnReadyRef.current = true;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeId
          ? { ...tab, mode, content: markdown !== null ? markdown : tab.content }
          : tab
      )
    );
  };

  const askNewFile = (parent: string) => {
    setPrompt({
      title: "新建文稿",
      description: "文稿会创建在当前工作区中。",
      initialValue: "未命名.md",
      confirmLabel: "创建文稿",
      onSubmit: async (value) => {
        const fileName = withMarkdownExtension(value);
        const path = await createFile(parent, fileName, "");
        await refreshTree();
        await openDocument(path);
      }
    });
  };

  const askNewFolder = (parent: string) => {
    setPrompt({
      title: "新建文件夹",
      description: "文件夹会创建在当前工作区中。",
      initialValue: "新文件夹",
      confirmLabel: "创建文件夹",
      onSubmit: async (value) => {
        await createFolder(parent, value);
        await refreshTree();
      }
    });
  };

  const askRename = (node: FileNode) => {
    setPrompt({
      title: "重命名",
      description: node.path,
      initialValue: node.name,
      confirmLabel: "重命名",
      onSubmit: async (value) => {
        const created = await renamePath(node.path, value);
        setTabs((current) =>
          current.map((tab) => {
            if (!tab.path) return tab;
            const normalizedTab = normalizeSlashes(tab.path);
            const normalizedOld = normalizeSlashes(node.path);
            if (normalizedTab === normalizedOld) {
              return { ...tab, path: created, name: baseName(created) };
            }
            if (node.isDir && normalizedTab.startsWith(normalizedOld + "/")) {
              return {
                ...tab,
                path: normalizeSlashes(created) + normalizedTab.slice(normalizedOld.length)
              };
            }
            return tab;
          })
        );
        await refreshTree();
      }
    });
  };

  const removeNode = async (node: FileNode) => {
    const normalizedTarget = normalizeSlashes(node.path);
    const dirtyAffected = tabsRef.current.filter((tab) => {
      if (!tab.path || !isTabDirty(tab)) return false;
      const path = normalizeSlashes(tab.path);
      return path === normalizedTarget || (node.isDir && path.startsWith(normalizedTarget + "/"));
    }).length;
    const confirmed = await confirmDialog(
      "将“" + node.name + "”移到回收站？" + (dirtyAffected
        ? " 其中 " + dirtyAffected + " 个标签还有未保存内容，这些编辑缓冲会被放弃。"
        : ""),
      {
        title: "移到回收站",
        kind: "warning",
        okLabel: dirtyAffected ? "放弃编辑并移回收站" : "移到回收站",
        cancelLabel: "取消"
      }
    );
    if (!confirmed) return;
    try {
      await trashPath(node.path);
      const normalizedNode = normalizeSlashes(node.path);
      const next = tabsRef.current.filter((tab) => {
        if (!tab.path) return true;
        const normalizedTab = normalizeSlashes(tab.path);
        return normalizedTab !== normalizedNode &&
          !(node.isDir && normalizedTab.startsWith(normalizedNode + "/"));
      });
      const activeGone = activeIdRef.current !== null &&
        !next.some((tab) => tab.id === activeIdRef.current);
      if (activeGone && activeIdRef.current) cancelTask("content:" + activeIdRef.current);
      setTabs(next);
      if (activeGone) setActiveId(next[0]?.id ?? null);
      await refreshTree();
      showToast("已移到回收站", "success");
    } catch (error) {
      showToast(String(error), "error");
    }
  };

  const exportHtml = async () => {
    if (!activeTab || exporting) return;
    const tab = activeTab;
    const content = freshContentForTab(tab);
    const defaultName = tab.name.replace(/\.[^.]+$/, "") + ".html";
    const target = await saveHtmlAs(
      workspace ? normalizeSlashes(workspace) + "/" + defaultName : defaultName
    );
    if (!target) return;
    setExporting(true);
    try {
      const { standaloneHtml } = await import("./lib/export-html");
      const html = standaloneHtml(tab.name, content, tab.path, settings.theme);
      await writeExport(target, html);
      showToast("HTML 已导出", "success");
    } catch (error) {
      showToast(String(error), "error");
    } finally {
      setExporting(false);
    }
  };

  const exportMarkdown = async () => {
    if (!activeTab || exporting) return;
    const tab = activeTab;
    const content = freshContentForTab(tab);
    const defaultName = tab.name.replace(/\.[^.]+$/, "") + ".md";
    const chosen = await saveMarkdownAs(
      workspace ? normalizeSlashes(workspace) + "/" + defaultName : defaultName
    );
    if (!chosen) return;
    const target = withMarkdownExtension(chosen);
    setExporting(true);
    try {
      await writeExport(target, content);
      showToast("Markdown 副本已导出", "success");
    } catch (error) {
      showToast(String(error), "error");
    } finally {
      setExporting(false);
    }
  };

  const exportDocx = async () => {
    if (!activeTab || exporting) return;
    const tab = activeTab;
    const content = freshContentForTab(tab);
    const defaultName = tab.name.replace(/\.[^.]+$/, "") + ".docx";
    const chosen = await saveDocxAs(
      workspace ? normalizeSlashes(workspace) + "/" + defaultName : defaultName
    );
    if (!chosen) return;
    const target = /\.docx$/i.test(chosen) ? chosen : chosen + ".docx";
    setExporting(true);
    try {
      const { buildDocx } = await import("./lib/docx-export");
      const result = await buildDocx({
        title: tab.name,
        markdown: content,
        documentPath: tab.path,
        workspace
      });
      await writeExportBytes(target, result.bytes);
      if (result.warnings.length) {
        showToast(
          "DOCX 已导出；" + result.warnings[0] + (result.warnings.length > 1 ? " 等提示" : ""),
          "info"
        );
      } else {
        showToast("DOCX 已导出", "success");
      }
    } catch (error) {
      showToast("DOCX 导出失败：" + String(error), "error");
    } finally {
      setExporting(false);
    }
  };

  // The other editor lives in its own lazy chunk; fetching it while the writer
  // is idle removes the network/parse half of the first mode switch.
  const prewarmOtherEditor = (mode: EditorMode) => {
    if (mode !== "source") return;
    void import("./components/RichEditor").catch(() => undefined);
  };
  const prewarmOnIdle = (mode: EditorMode) => {
    // A short timer beats requestIdleCallback here: idle callbacks can be
    // postponed until after the first mode switch, which is exactly too late.
    window.setTimeout(() => prewarmOtherEditor(mode), 700);
  };

  // Switching modes remounts the editor, so the scroll container is replaced.
  // Keep the relative scroll position across that boundary (plan M2/8.3).
  const findScrollable = (): HTMLElement | null => {
    const sourceScroller = document.querySelector<HTMLElement>(".cm-scroller");
    if (sourceScroller && sourceScroller.scrollHeight > sourceScroller.clientHeight + 2) {
      return sourceScroller;
    }
    return document.querySelector<HTMLElement>(".editor-viewport");
  };
  const captureScrollContext = () => {
    const scroller = findScrollable();
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    scrollContextRef.current = { ratio: max > 0 ? scroller.scrollTop / max : 0 };
  };
  const restoreScrollContext = () => {
    const saved = scrollContextRef.current;
    scrollContextRef.current = null;
    if (!saved) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const scroller = findScrollable();
        if (!scroller) return;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max <= 0) return;
        const previous = scroller.style.scrollBehavior;
        scroller.style.scrollBehavior = "auto";
        scroller.scrollTop = Math.round(saved.ratio * max);
        scroller.style.scrollBehavior = previous;
      });
    });
  };

  const handleRichReady = () => {
    setEditorReadyRevision((value) => value + 1);
    richReadyRef.current = true;
    if (contentSnapshotRef.current === null) {
      contentSnapshotRef.current = richRef.current?.getInitialMarkdown() ?? null;
    }
    sinceModeSwitch("mode_switch_ready");
    window.requestAnimationFrame(() => sinceModeSwitch("mode_switch_paint"));
    restoreScrollContext();
    prewarmOnIdle("rich");
    if (focusOnReadyRef.current) {
      focusOnReadyRef.current = false;
      richRef.current?.focus();
    }
    if (pendingPrintRef.current) {
      pendingPrintRef.current = false;
      window.print();
    }
  };

  const handleSourceReady = () => {
    setEditorReadyRevision((value) => value + 1);
    sourceReadyRef.current = true;
    sinceModeSwitch("mode_switch_ready");
    window.requestAnimationFrame(() => sinceModeSwitch("mode_switch_paint"));
    restoreScrollContext();
    prewarmOnIdle("source");
    if (focusOnReadyRef.current) {
      focusOnReadyRef.current = false;
      sourceRef.current?.focus();
    }
  };

  const printDocument = () => {
    if (!activeTab) return;
    if (activeTab.mode !== "rich" || !richReadyRef.current) {
      pendingPrintRef.current = true;
      if (activeTab.mode !== "rich") setMode("rich");
      showToast("正在准备排版，完成后打开打印窗口…", "info");
      return;
    }
    window.print();
  };

  const jumpToMatch = (backwards = false) => {
    if (!findQuery || !activeTab) return;
    if (activeTab.mode === "source") {
      const found = sourceRef.current?.findNext(findQuery, backwards);
      if (!found) showToast("没有更多匹配。", "info");
      return;
    }
    const found = richRef.current?.findNext(findQuery, backwards);
    if (!found) showToast("没有更多匹配。", "info");
  };

  const replaceAll = () => {
    if (!activeTab || !findQuery) return;
    const regex = new RegExp(escapeRegExp(findQuery), "gi");
    const source = freshContentForTab(activeTab);
    const count = (source.match(regex) ?? []).length;
    if (count === 0) {
      showToast("没有可替换的匹配。", "info");
      return;
    }
    const next = source.replace(regex, () => replacement);
    if (activeTab.mode === "rich") richRef.current?.replaceContent(next, false);
    else sourceRef.current?.replaceAll(next);
    contentSnapshotRef.current = next;
    updateActiveContent(next);
    showToast("已替换 " + count + " 处", "success");
  };

  const jumpOutline = (item: OutlineItem, index: number) => {
    if (!activeTab) return;
    if (activeTab.mode === "source") sourceRef.current?.scrollToLine(item.line);
    else richRef.current?.scrollToHeading(index);
  };

  useEffect(() => {
    // Files opened from Explorer (first launch or "open with") arrive here.
    let disposed = false;
    const handleLaunch = (payload: { paths?: string[]; errors?: string[] } | null | undefined) => {
      if (disposed || !payload) return;
      for (const message of payload.errors ?? []) showToast(message, "error");
      for (const path of payload.paths ?? []) void openPathHandlerRef.current(path);
    };
    const unlisten = listen<{ paths: string[]; errors: string[] }>("inkstone://open-paths", (event) =>
      handleLaunch(event.payload)
    );
    void takePendingOpen()
      .then(handleLaunch)
      .catch((error) => showToast("无法读取启动文件：" + String(error), "error"));
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(WORKSPACE_KEY);
    if (!saved) return;
    // Keep the key on failure: the welcome page should offer a re-pick instead
    // of silently forgetting the last workspace.
    void (async () => {
      try {
        const nodes = await readWorkspace(saved);
        setWorkspace(saved);
        setTree(nodes);
      } catch {
        showToast("上次工作区不可用：" + saved + "，请重新选择。", "error");
      }
    })();
  }, []);

  useEffect(() => {
    if (!workspace) {
      setWorkspaceReadOnly(false);
      return;
    }
    let alive = true;
    void workspaceWritable(workspace)
      .then((writable) => {
        if (alive) setWorkspaceReadOnly(!writable);
      })
      .catch(() => {
        if (alive) setWorkspaceReadOnly(false);
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  useEffect(() => {
    void syncDesktopGlass(settings.reduceTransparency, settings.theme);
  }, [settings.reduceTransparency, settings.theme]);

  useEffect(() => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  }, [recent]);

  useEffect(() => {
    if (restoredDrafts.current) showToast("已恢复未命名草稿", "success");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = timeSync("drafts_persist", () => persistDrafts(tabsRef.current));
      if (!saved && !draftWarningShown.current) {
        showToast("本机草稿保存失败，请使用另存为。", "error");
        draftWarningShown.current = true;
      }
      if (saved) draftWarningShown.current = false;
    }, 800);
    return () => window.clearTimeout(timer);
  }, [tabs, docRevision]);

  useEffect(() => {
    if (!settings.autoSave) return;
    const pending = tabs.filter((tab) =>
      tab.path !== null && isTabDirty(tab) && !saveConflictIds.has(tab.id)
    );
    if (!pending.length) return;
    const timer = window.setTimeout(() => {
      pending.forEach((tab) => void queueSave(tab.id, false, true));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [tabs, docRevision, settings.autoSave, saveConflictIds]);

  useEffect(() => {
    // A tab switch tears both instances down (they are keyed by tab id).
    richReadyRef.current = false;
    sourceReadyRef.current = false;
    pendingPrintRef.current = false;
    contentSnapshotRef.current = null;
  }, [activeId]);

  useEffect(() => {
    if (!metricsEnabled) return;
    const probe = {
      activeTab: () => {
        const tab = tabsRef.current.find((item) => item.id === activeIdRef.current) ?? null;
        return tab
          ? { id: tab.id, name: tab.name, mode: tab.mode, path: tab.path, content: tab.content, dirty: isTabDirty(tab) }
          : null;
      },
      tabs: () => tabsRef.current.map((tab) => ({
        id: tab.id, name: tab.name, mode: tab.mode, path: tab.path,
        dirty: isTabDirty(tab), length: tab.content.length
      })),
      revision: (id: string) => revisionsRef.current.get(id) ?? 0,
      flush: () => {
        const tab = tabsRef.current.find((item) => item.id === activeIdRef.current) ?? null;
        return flushTabContent(tab);
      }
    };
    (window as Window & { __inkTest?: unknown }).__inkTest = probe;
    return () => {
      delete (window as Window & { __inkTest?: unknown }).__inkTest;
    };
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const sidebarDrawer = settings.showSidebar && viewportWidth <= 760;
  const outlineDrawer = settings.showOutline && Boolean(activeTab) && viewportWidth <= 1220;
  useEffect(() => {
    if (!sidebarDrawer && !outlineDrawer) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      const selector = sidebarDrawer ? ".sidebar .icon-button" : ".outline-heading .icon-button";
      document.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, [sidebarDrawer, outlineDrawer]);

  useEffect(() => {
    if (!sidebarDrawer && !outlineDrawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || findOpen || commandOpen || shortcutsOpen || prompt || settingsOpen || exportOpen) return;
      event.preventDefault();
      if (outlineDrawer) patchSettings({ showOutline: false });
      if (sidebarDrawer) patchSettings({ showSidebar: false });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarDrawer, outlineDrawer, findOpen, commandOpen, shortcutsOpen, prompt, settingsOpen, exportOpen]);

  useEffect(() => {
    document.title = activeTab ? activeTab.name + " — Inkstone" : "Inkstone";
  }, [activeTab?.name]);

  useEffect(() => {
    const flushForUnload = (): Tab[] => {
      const current = tabsRef.current;
      const active = current.find((tab) => tab.id === activeIdRef.current) ?? null;
      const markdown = flushTabContent(active);
      if (markdown === null || !active) return current;
      return current.map((tab) => (tab.id === active.id ? { ...tab, content: markdown } : tab));
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const flushed = flushForUnload();
      const draftsSaved = persistDrafts(flushed);
      const hasUnsafeChanges = flushed.some((tab) =>
        isTabDirty(tab) && (tab.path !== null || !draftsSaved)
      );
      if (hasUnsafeChanges) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      persistDrafts(flushForUnload());
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const openCommandCenter = () => {
    setSettingsOpen(false);
    setExportOpen(false);
    setFindOpen(false);
    setCommandOpen(true);
  };

  const openShortcutHelp = () => {
    setSettingsOpen(false);
    setExportOpen(false);
    setShortcutsOpen(true);
  };

  const toggleFocusMode = () => {
    if (!activeTab) return;
    setFocusMode((current) => {
      if (!current) {
        setFindOpen(false);
        setSettingsOpen(false);
        setExportOpen(false);
      }
      return !current;
    });
  };

  const activateTabAt = (index: number) => {
    const target = tabs[index];
    if (!target) return;
    activateTab(target.id);
    window.requestAnimationFrame(() => document.getElementById("tab-" + target.id)?.focus());
  };

  const activateRelativeTab = (direction: number) => {
    if (tabs.length < 2) return;
    const current = tabs.findIndex((tab) => tab.id === activeId);
    const base = current < 0 ? 0 : current;
    activateTabAt((base + direction + tabs.length) % tabs.length);
  };

  const openFind = () => {
    if (!findOpen) findReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setFindOpen(true);
    setFindFocusRevision((value) => value + 1);
  };

  const closeFind = () => {
    setFindOpen(false);
    window.requestAnimationFrame(() => {
      const previous = findReturnFocusRef.current;
      if (previous?.isConnected && !previous.closest(".find-bar")) previous.focus();
      else if (activeTab?.mode === "source") sourceRef.current?.focus();
      else richRef.current?.focus();
    });
  };

  const commandRef = useRef({
    save: () => undefined as void,
    saveAs: () => undefined as void,
    newDoc: () => undefined as void,
    openFile: () => undefined as void,
    openFolder: () => undefined as void,
    close: () => undefined as void,
    find: () => undefined as void,
    print: () => undefined as void,
    mode: () => undefined as void,
    palette: () => undefined as void,
    focus: () => undefined as void,
    shortcuts: () => undefined as void,
    nextTab: () => undefined as void,
    previousTab: () => undefined as void,
    next: () => undefined as void,
    previous: () => undefined as void
  });
  commandRef.current = {
    save: () => void saveActive(false),
    saveAs: () => void saveActive(true),
    newDoc: newDocument,
    openFile: () => void openFileDialog(),
    openFolder: () => void openFolderDialog(),
    close: () => { if (activeTab) void closeTab(activeTab.id); },
    find: openFind,
    print: printDocument,
    mode: () => { if (activeTab) setMode(activeTab.mode === "rich" ? "source" : "rich"); },
    palette: openCommandCenter,
    focus: toggleFocusMode,
    shortcuts: openShortcutHelp,
    nextTab: () => activateRelativeTab(1),
    previousTab: () => activateRelativeTab(-1),
    next: () => jumpToMatch(false),
    previous: () => jumpToMatch(true)
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (commandOpen || shortcutsOpen || prompt || settingsOpen || exportOpen) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) commandRef.current.previousTab();
        else commandRef.current.nextTab();
        return;
      }
      if (!modifier) {
        if (event.key === "F1") {
          event.preventDefault();
          commandRef.current.shortcuts();
          return;
        }
        if (event.key === "F3") {
          event.preventDefault();
          if (event.shiftKey) commandRef.current.previous();
          else commandRef.current.next();
        }
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) commandRef.current.saveAs();
        else commandRef.current.save();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        commandRef.current.newDoc();
      } else if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (event.shiftKey) commandRef.current.openFolder();
        else commandRef.current.openFile();
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        commandRef.current.close();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        commandRef.current.find();
      } else if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        commandRef.current.mode();
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        commandRef.current.print();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        commandRef.current.palette();
      } else if (event.key.toLowerCase() === "d" && event.shiftKey) {
        event.preventDefault();
        commandRef.current.focus();
      } else if (event.code === "Slash") {
        // Ctrl+/ toggles source/rendered, matching the editor-heavy muscle memory.
        event.preventDefault();
        commandRef.current.mode();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen, shortcutsOpen, prompt, settingsOpen, exportOpen]);

  useEffect(() => {
    if (!settingsOpen && !exportOpen) return;
    const closeMenus = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest(".popover") || target.closest(".popover-trigger")) return;
      setSettingsOpen(false);
      setExportOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSettingsOpen(false);
      setExportOpen(false);
    };
    window.addEventListener("mousedown", closeMenus);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeMenus);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsOpen, exportOpen]);

  const commandActions: CommandAction[] = [
    {
      id: "new-document",
      label: "新建文稿",
      description: "从一张空白纸开始",
      section: "文稿",
      shortcut: "Ctrl N",
      keywords: "new create blank empty 新建 空白",
      icon: <FilePlus2 size={16} />,
      run: () => commandRef.current.newDoc()
    },
    {
      id: "open-file",
      label: "打开文件",
      description: "打开一篇本地 Markdown 文稿",
      section: "文稿",
      shortcut: "Ctrl O",
      keywords: "open file markdown 打开 文件",
      icon: <FileText size={16} />,
      run: () => commandRef.current.openFile()
    },
    {
      id: "open-workspace",
      label: "打开工作区",
      description: "选择一个文件夹作为写作空间",
      section: "文稿",
      shortcut: "Ctrl Shift O",
      keywords: "open folder workspace 工作区 文件夹",
      icon: <FolderOpen size={16} />,
      run: () => commandRef.current.openFolder()
    },
    ...(activeTab ? [
      {
        id: "save-document",
        label: "保存当前文稿",
        description: "立即写入当前文件",
        section: "文稿",
        shortcut: "Ctrl S",
        keywords: "save current file 保存 写入",
        icon: <Save size={16} />,
        run: () => commandRef.current.save()
      },
      {
        id: "save-as",
        label: "另存为",
        description: "把当前内容保存到新的位置",
        section: "文稿",
        shortcut: "Ctrl Shift S",
        keywords: "save as export copy 另存 副本",
        icon: <Download size={16} />,
        run: () => commandRef.current.saveAs()
      },
      {
        id: "find-replace",
        label: "查找与替换",
        description: "在当前文稿中查找文字",
        section: "文稿",
        shortcut: "Ctrl F",
        keywords: "find replace search 查找 替换 搜索",
        icon: <Search size={16} />,
        run: () => commandRef.current.find()
      },
      {
        id: "export-document",
        label: "导出当前文稿",
        description: "DOCX、HTML、Markdown 或 PDF",
        section: "文稿",
        keywords: "export docx html pdf markdown 导出 下载",
        icon: <Download size={16} />,
        run: () => setExportOpen(true)
      },
      {
        id: "workspace-from-file",
        label: "将文稿所在文件夹设为工作区",
        description: "把当前文件所在的目录作为写作空间",
        section: "工作区",
        keywords: "workspace folder current file 工作区 文件夹 当前",
        icon: <FolderOpen size={16} />,
        run: () => {
          const path = activeTab?.path;
          if (!path) return;
          const normalized = normalizeSlashes(path);
          const directory = normalized.slice(0, normalized.lastIndexOf("/"));
          if (directory) void openWorkspacePath(directory);
        }
      },
      {
        id: "default-markdown-app",
        label: "设为默认 Markdown 应用",
        description: "打开 Windows 默认应用设置，由你确认",
        section: "工作区",
        keywords: "default app association markdown 默认 打开方式",
        icon: <ShieldCheck size={16} />,
        run: () => {
          void openDefaultAppsSettings().catch((error) => showToast(String(error), "error"));
        }
      },
      {
        id: "toggle-editor-mode",
        label: activeTab.mode === "rich" ? "切换到 Markdown 源码" : "切换到所见即所得",
        description: "改变当前文稿的编辑方式",
        section: "视图",
        shortcut: "Ctrl E / Ctrl /",
        keywords: "source rich wysiwyg markdown 源码 编辑 模式",
        icon: activeTab.mode === "rich" ? <FileCode2 size={16} /> : <BookOpen size={16} />,
        run: () => commandRef.current.mode()
      },
      {
        id: "toggle-focus",
        label: focusMode ? "退出专注写作" : "进入专注写作",
        description: focusMode ? "恢复完整工作台" : "隐藏侧栏与非正文界面",
        section: "视图",
        shortcut: "Ctrl Shift D",
        keywords: "focus zen distraction free 专注 写作 全屏",
        icon: focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />,
        run: () => commandRef.current.focus()
      },
      {
        id: "close-document",
        label: "关闭当前标签",
        description: "关闭当前文稿标签",
        section: "文稿",
        shortcut: "Ctrl W",
        keywords: "close tab document 关闭 标签",
        icon: <X size={16} />,
        run: () => commandRef.current.close()
      }
    ] as CommandAction[] : []),
    {
      id: "toggle-sidebar",
      label: settings.showSidebar ? "收起文件侧栏" : "显示文件侧栏",
      description: "调整工作区导航空间",
      section: "视图",
      keywords: "sidebar files panel 侧栏 文件 导航",
      icon: <PanelLeft size={16} />,
      run: () => patchSettings({ showSidebar: !settings.showSidebar })
    },
    {
      id: "toggle-outline",
      label: settings.showOutline ? "收起大纲" : "显示大纲",
      description: "查看当前文稿的标题结构",
      section: "视图",
      keywords: "outline headings panel 大纲 标题 结构",
      icon: <PanelRight size={16} />,
      run: () => patchSettings({ showOutline: !settings.showOutline })
    },
    {
      id: "cycle-theme",
      label: "切换主题",
      description: "当前为" + themeName(settings.theme) + "，切换到下一套主题",
      section: "视图",
      keywords: "theme paper sepia night dark 主题 夜间 旧纸",
      icon: themeIcon(settings.theme),
      run: () => patchSettings({ theme: nextTheme(settings.theme) })
    },
    {
      id: "toggle-autosave",
      label: settings.autoSave ? "关闭自动保存" : "开启自动保存",
      description: settings.autoSave ? "改为仅手动保存" : "停止输入后自动写入文件",
      section: "设置",
      keywords: "autosave save settings 自动保存 设置",
      icon: <ShieldCheck size={16} />,
      run: () => patchSettings({ autoSave: !settings.autoSave })
    },
    {
      id: "keyboard-shortcuts",
      label: "键盘快捷键",
      description: "查看所有主要操作的快捷键",
      section: "帮助",
      shortcut: "F1",
      keywords: "keyboard shortcuts help 快捷键 帮助",
      icon: <Keyboard size={16} />,
      run: () => commandRef.current.shortcuts()
    }
  ];

  const editorStyle = {
    "--editor-font-size": settings.fontSize + "px",
    "--reading-measure": settings.measure + "px"
  } as CSSProperties;
  record("app_render", performance.now() - renderStartedAt, { tabs: tabs.length });

  const activeSaveLabel = !activeTab
    ? ""
    : saveConflictIds.has(activeTab.id)
      ? "磁盘版本冲突"
      : autoSavingIds.has(activeTab.id)
      ? "正在自动保存"
      : !isTabDirty(activeTab)
        ? "已保存"
        : activeTab.path && settings.autoSave
          ? "等待自动保存"
          : !activeTab.path && activeTab.content && !hasPendingTask("content:" + activeTab.id)
            ? "草稿已保存在本机"
            : activeTab.path === null && hasPendingTask("content:" + activeTab.id)
              ? "正在生成本机草稿"
              : "未保存";

  return (
    <div
      className={"app" + (focusMode ? " is-focus" : "") + (settings.reduceTransparency ? " reduce-transparency" : "")}
      data-theme={settings.theme}
    >
      <header className="app-header">
        <div className="brand-block" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
          <img className="brand-mark" src={brandMark} alt="" aria-hidden="true" draggable={false} />
          <div className="brand-copy">
            <strong>Inkstone</strong>
            <span>写作工作台</span>
          </div>
        </div>
        <div className="header-rule" />
        {!settings.showSidebar && (
          <button
            className="icon-button quiet"
            title="显示文件树"
            onClick={() => patchSettings({ showSidebar: true })}
          >
            <PanelLeft size={17} />
          </button>
        )}
        <div className="header-document" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
          <span>{activeTab?.name ?? "写作台"}</span>
          <small>{workspace ? baseName(workspace) : "本地优先写作"}</small>
        </div>
        <button className="command-trigger" onClick={openCommandCenter} aria-label="打开命令中心">
          <CommandIcon size={15} />
          <span>搜索命令</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="header-actions">
          <button className="icon-button quiet" title="查找 (Ctrl+F)" onClick={openFind}>
            <Search size={17} />
          </button>
          <button
            className="icon-button quiet"
            title="保存 (Ctrl+S)"
            onClick={() => void saveActive(false)}
            disabled={!activeTab || busy}
          >
            <Save size={17} />
          </button>
          <div className="popover-anchor">
            <button
              className="icon-button quiet popover-trigger"
              title="导出"
              aria-expanded={exportOpen}
              aria-haspopup="menu"
              aria-controls="export-menu"
              onClick={() => {
                setExportOpen((current) => !current);
                setSettingsOpen(false);
              }}
              disabled={!activeTab || exporting}
            >
              <Download size={17} />
            </button>
            {exportOpen && (
              <div className="popover export-menu" id="export-menu" role="menu" aria-label="导出当前文稿">
                <div className="export-menu-title">导出当前文稿</div>
                <button role="menuitem" onClick={() => { setExportOpen(false); void exportDocx(); }}>
                  <FileType2 size={16} />
                  <span>Word 文档<small>DOCX，可继续编辑</small></span>
                </button>
                <button role="menuitem" onClick={() => { setExportOpen(false); void exportHtml(); }}>
                  <FileCode2 size={16} />
                  <span>HTML 网页<small>保留排版与本地图片路径</small></span>
                </button>
                <button role="menuitem" onClick={() => { setExportOpen(false); void exportMarkdown(); }}>
                  <FileText size={16} />
                  <span>Markdown 副本<small>原始 Markdown 内容</small></span>
                </button>
                <div className="export-menu-divider" />
                <button role="menuitem" onClick={() => { setExportOpen(false); printDocument(); }}>
                  <Printer size={16} />
                  <span>打印 / 另存 PDF<small>通过系统打印窗口</small></span>
                </button>
              </div>
            )}
          </div>
          <button
            className="icon-button quiet"
            title={"切换主题 · 当前：" + themeName(settings.theme)}
            onClick={() => patchSettings({ theme: nextTheme(settings.theme) })}
          >
            {themeIcon(settings.theme)}
          </button>
          <div className="popover-anchor">
            <button
              className="icon-button quiet popover-trigger"
              title="偏好设置"
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              aria-controls="settings-popover"
              onClick={() => {
                setSettingsOpen((current) => !current);
                setExportOpen(false);
              }}
            >
              <Settings2 size={17} />
            </button>
            {settingsOpen && (
              <div className="popover settings-popover" id="settings-popover" role="dialog" aria-label="偏好设置">
                <div className="popover-title">偏好设置</div>
                <span className="settings-label">主题</span>
                <div className="theme-options">
                  {(["paper", "sepia", "night"] as ThemeName[]).map((theme) => (
                    <button
                      key={theme}
                      className={"theme-option" + (settings.theme === theme ? " is-active" : "")}
                      onClick={() => patchSettings({ theme })}
                    >
                      <span className={"theme-swatch swatch-" + theme} />
                      {themeName(theme)}
                    </button>
                  ))}
                </div>
                <label className="range-row">
                  <span>正文字号</span>
                  <input
                    type="range"
                    min="14"
                    max="24"
                    step="1"
                    value={settings.fontSize}
                    onChange={(event) => patchSettings({ fontSize: Number(event.target.value) })}
                  />
                  <b>{settings.fontSize}px</b>
                </label>
                <label className="range-row">
                  <span>版心宽度</span>
                  <input
                    type="range"
                    min="560"
                    max="920"
                    step="20"
                    value={settings.measure}
                    onChange={(event) => patchSettings({ measure: Number(event.target.value) })}
                  />
                  <b>{settings.measure}px</b>
                </label>
                <label className="settings-toggle">
                  <span className="toggle-copy">
                    <strong>自动保存</strong>
                    <small>停止输入 1.2 秒后保存到原文件</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.autoSave}
                    onChange={(event) => patchSettings({ autoSave: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle">
                  <span className="toggle-copy">
                    <strong>减少透明效果</strong>
                    <small>关闭桌面 Acrylic，工具层改为实心纸面</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.reduceTransparency}
                    onChange={(event) => patchSettings({ reduceTransparency: event.target.checked })}
                  />
                </label>
                <p className="settings-note">未命名文稿会保留为本机草稿。设置只保存在本机。</p>
              </div>
            )}
          </div>
        </div>
        <WindowControls onClose={() => { void requestWindowClose(); }} />
      </header>

      {focusMode && (
        <div className="focus-window-bar" onMouseDown={startWindowDrag}>
          <WindowControls onClose={() => { void requestWindowClose(); }} />
        </div>
      )}

      <div
        className="workspace-shell"
        style={{ "--sidebar-visible": settings.showSidebar ? "1" : "0" } as CSSProperties}
      >
        {settings.showSidebar && (
          <Sidebar
            workspace={workspace}
            tree={tree}
            activePath={activeTab?.path ?? null}
            onOpenFolder={() => void openFolderDialog()}
            onOpenFile={(path) => void openDocument(path)}
            onRefresh={() => void refreshTree()}
            onCreateFile={askNewFile}
            onCreateFolder={askNewFolder}
            onRename={askRename}
            onTrash={(node) => void removeNode(node)}
            onReveal={(node) => void revealInExplorer(node.path)}
            onClose={() => patchSettings({ showSidebar: false })}
          />
        )}

        <main className="main-column">
          {tabs.length > 0 && (
            <div className="tab-strip">
              <div className="tabs-scroll" role="tablist" aria-label="打开的文稿">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    id={"tab-" + tab.id}
                    className={"tab-item" + (tab.id === activeId ? " is-active" : "")}
                    role="tab"
                    tabIndex={tab.id === activeId ? 0 : -1}
                    aria-selected={tab.id === activeId}
                    onClick={() => activateTab(tab.id)}
                    onAuxClick={(event) => {
                      if (event.button === 1) void closeTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activateTab(tab.id);
                      } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        const index = tabs.findIndex((item) => item.id === tab.id);
                        let target = index;
                        if (event.key === "ArrowLeft") target = Math.max(0, index - 1);
                        if (event.key === "ArrowRight") target = Math.min(tabs.length - 1, index + 1);
                        if (event.key === "Home") target = 0;
                        if (event.key === "End") target = tabs.length - 1;
                        activateTabAt(target);
                      }
                    }}
                  >
                    <FileText size={14} />
                    <span>{tab.name}</span>
                    {isTabDirty(tab) && <i className="dirty-dot" title="未保存" />}
                    <button
                      type="button"
                      className="tab-close"
                      aria-label={"关闭 " + tab.name}
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeTab(tab.id);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="tab-new" title="新建文稿 (Ctrl+N)" onClick={newDocument}>
                <FilePlus2 size={16} />
              </button>
            </div>
          )}

          {activeTab ? (
            <>
              <div className="document-toolbar">
                <div className="mode-switch" role="group" aria-label="编辑模式">
                  <button
                    className={activeTab.mode === "rich" ? "is-active" : ""}
                    onClick={() => setMode("rich")}
                    title="所见即所得编辑"
                  >
                    <BookOpen size={14} /> 编辑
                  </button>
                  <button
                    className={activeTab.mode === "source" ? "is-active" : ""}
                    onClick={() => setMode("source")}
                    title="Markdown 源码（Ctrl+E / Ctrl+/）"
                  >
                    <span className="source-glyph">M↓</span> 源码
                  </button>
                </div>
                {workspace && workspaceReadOnly && (
                  <span className="readonly-badge" title="当前工作区不可写，保存会失败">只读</span>
                )}
                <div className="document-state">
                  <span
                    className={"save-state" + (isTabDirty(activeTab) ? " is-dirty" : "") + (autoSavingIds.has(activeTab.id) ? " is-saving" : "")}
                    title={saveConflictIds.has(activeTab.id) ? "磁盘文件已变化，请另存为或关闭后重新打开" : undefined}
                  >
                    {activeSaveLabel}
                  </span>
                  {activeTab.path && <span className="document-path" title={activeTab.path}>{relativeDocumentPath(activeTab.path, workspace)}</span>}
                </div>
                <div className="document-actions">
                  <button className="icon-button quiet" title="打印 / 另存 PDF" onClick={printDocument}>
                    <Printer size={16} />
                  </button>
                  <button
                    className={"icon-button quiet" + (settings.showOutline ? " is-on" : "")}
                    title="切换大纲"
                    onClick={() => patchSettings({ showOutline: !settings.showOutline })}
                  >
                    <PanelRight size={16} />
                  </button>
                  <button
                    className={"icon-button quiet focus-toggle" + (focusMode ? " is-on" : "")}
                    title={focusMode ? "退出专注写作 (Ctrl+Shift+D)" : "进入专注写作 (Ctrl+Shift+D)"}
                    onClick={toggleFocusMode}
                  >
                    {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                </div>
              </div>

              {saveConflictIds.has(activeTab.id) && (
                <div className="conflict-banner" role="alert">
                  <AlertCircle size={16} />
                  <span>磁盘版本已变化，自动保存已暂停。</span>
                  <div className="conflict-actions">
                    <button type="button" onClick={() => void saveActive(true)}>另存为</button>
                    <button type="button" onClick={() => void reloadActiveFromDisk()}>重新加载</button>
                  </div>
                </div>
              )}

              {findOpen && (
                <FindBar
                  query={findQuery}
                  replacement={replacement}
                  matchCount={matchCount}
                  focusSignal={findFocusRevision}
                  onQueryChange={setFindQuery}
                  onReplacementChange={setReplacement}
                  onNext={() => jumpToMatch(false)}
                  onPrevious={() => jumpToMatch(true)}
                  onReplaceAll={replaceAll}
                  onClose={closeFind}
                />
              )}

              <div className="editor-viewport" style={editorStyle}>
                <div className="editor-paper">
                  <Suspense fallback={<div className="editor-loading"><span className="loading-spinner" />正在准备编辑器…</div>}>
                    {activeTab.mode === "rich" ? (
                      <RichEditor
                        key={activeTab.id + "-rich-" + editorEpoch}
                        ref={richRef}
                        initialMarkdown={activeTab.content}
                        workspace={workspace}
                        documentPath={activeTab.path}
                        onChange={updateActiveContent}
                        onDocChanged={(size, sample) => handleDocChanged(size, sample, editorEpoch)}
                        onReady={handleRichReady}
                        onUseSource={() => setMode("source")}
                      />
                    ) : (
                      <SourceEditor
                        key={activeTab.id + "-source-" + editorEpoch}
                        ref={sourceRef}
                        initialMarkdown={activeTab.content}
                        theme={settings.theme}
                        fontSize={settings.fontSize}
                        onDocChanged={(size, sample) => handleDocChanged(size, sample, editorEpoch)}
                        onReady={handleSourceReady}
                      />
                    )}
                  </Suspense>
                </div>
              </div>

              <footer className="statusbar">
                <span>{stats.words.toLocaleString()} 字词</span>
                <span title="可见字符，不含 Markdown 标记与空白">{stats.characters.toLocaleString()} 字符</span>
                <span>{stats.minutes} 分钟阅读</span>
                <span className="statusbar-spacer" />
                <span>{activeTab.mode === "rich" ? "所见即所得" : "Markdown 源码"}</span>
                <span>{themeName(settings.theme)}</span>
              </footer>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-copy">
                <img className="welcome-mark" src={brandMark} alt="" aria-hidden="true" draggable={false} />
                <p className="welcome-line">本地 Markdown 工作台</p>
                <h1>让文字<br />先落下来。</h1>
                <p className="welcome-intro">
                  Inkstone 是一个本地优先的 Markdown 写作空间。文件留在你的电脑里，
                  专注留给正在发生的想法。
                </p>
                <div className="welcome-actions">
                  <button className="primary-button" onClick={newDocument}>
                    <FilePlus2 size={17} /> 新建文稿
                  </button>
                  <button className="text-button" onClick={() => void openFileDialog()}>
                    <FileText size={16} /> 打开文件
                  </button>
                  <button className="text-button" onClick={() => void openFolderDialog()}>
                    <FolderOpen size={16} /> 打开文件夹
                  </button>
                  <button className="text-button" onClick={() => void askNewWorkspace()}>
                    <FolderPlus size={16} /> 新建工作区
                  </button>
                </div>
                {recentWorkspaces.length > 0 && (
                  <div className="welcome-workspaces">
                    <div className="welcome-workspaces-head">最近工作区</div>
                    {recentWorkspaces.map((path) => (
                      <button
                        key={path}
                        className="welcome-workspace"
                        title={path}
                        onClick={() => void openWorkspacePath(path)}
                      >
                        <FolderOpen size={15} />
                        <span className="welcome-workspace-name">{baseName(path)}</span>
                        <span className="welcome-workspace-path">{path}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="welcome-aside">
                <div className="welcome-aside-head">
                  <span>最近文稿</span>
                  <span className="recent-count">{recent.length}</span>
                </div>
                {recent.length ? (
                  <div className="recent-list">
                    {recent.slice(0, 6).map((item) => (
                      <button
                        key={item.path}
                        className="recent-item"
                        onClick={() => void openDocument(item.path)}
                        title={item.path}
                      >
                        <span className="recent-file"><FileText size={16} /></span>
                        <span className="recent-copy">
                          <span className="recent-name">{item.name}</span>
                          <small>{formatRecentDate(item.at)}</small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="recent-empty">
                    <FileText size={22} strokeWidth={1.4} />
                    <p>最近打开的文稿会出现在这里。</p>
                  </div>
                )}
                <div className="welcome-shortcuts">
                  <div><kbd>Ctrl</kbd><kbd>N</kbd><span>新建</span></div>
                  <div><kbd>Ctrl</kbd><kbd>O</kbd><span>打开</span></div>
                  <div><kbd>Ctrl</kbd><kbd>S</kbd><span>保存</span></div>
                  <div><kbd>Ctrl</kbd><kbd>E</kbd><span>源码</span></div>
                </div>
                <p className="welcome-footnote">
                  <ShieldCheck size={15} />
                  <span>自动保存与本机草稿，文稿不会上传。</span>
                </p>
              </div>
            </div>
          )}
        </main>

        {settings.showOutline && activeTab && (
          <Outline
            items={outline}
            onJump={jumpOutline}
            onClose={() => patchSettings({ showOutline: false })}
            wordCount={stats.words}
            minutes={stats.minutes}
          />
        )}
      </div>

      {toast && (
        <div className={"toast " + toast.kind} role={toast.kind === "error" ? "alert" : "status"} aria-live={toast.kind === "error" ? "assertive" : "polite"}>
          <span className="toast-icon">
            {toast.kind === "success" ? <CheckCircle2 size={16} /> : toast.kind === "error" ? <AlertCircle size={16} /> : <Info size={16} />}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button className="toast-close" aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {(busy || exporting) && (
        <>
          <div className="busy-line" aria-hidden="true" />
          <div className="sr-only" role="status" aria-live="polite">{exporting ? "正在导出文稿" : "正在处理，请稍候"}</div>
        </>
      )}

      {prompt && <PromptDialog request={prompt} onClose={() => setPrompt(null)} />}
      {commandOpen && <CommandCenter actions={commandActions} onClose={() => setCommandOpen(false)} />}
      {shortcutsOpen && <ShortcutDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
