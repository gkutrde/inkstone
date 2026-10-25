import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import type { FileNode } from "../types";
import { searchWorkspace } from "../lib/api";
import { baseName, normalizeSlashes } from "../lib/path";
import { useModalA11y } from "../lib/useModalA11y";

interface SidebarProps {
  workspace: string | null;
  tree: FileNode[];
  activePath: string | null;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onCreateFile: (parent: string) => void;
  onCreateFolder: (parent: string) => void;
  onRename: (node: FileNode) => void;
  onTrash: (node: FileNode) => void;
  onReveal: (node: FileNode) => void;
  onClose: () => void;
}

interface MenuState {
  x: number;
  y: number;
  node: FileNode;
}

interface VisibleEntry {
  node: FileNode;
  depth: number;
  parentPath: string | null;
}

function flattenVisible(nodes: FileNode[], expanded: Set<string>, depth = 0, parentPath: string | null = null): VisibleEntry[] {
  return nodes.flatMap((node) => {
    const current = { node, depth, parentPath };
    if (!node.isDir || !expanded.has(node.path)) return [current];
    return [current, ...flattenVisible(node.children, expanded, depth + 1, node.path)];
  });
}

function TreeRow({
  node,
  depth,
  activePath,
  focusedPath,
  expanded,
  onToggle,
  onOpen,
  onContextMenu,
  onFocus
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  focusedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (event: React.SyntheticEvent, node: FileNode) => void;
  onFocus: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const active = activePath === node.path;
  return (
    <>
      <div
        className={"tree-row" + (active ? " is-active" : "")}
        style={{ paddingLeft: 10 + depth * 16 }}
        data-path={node.path}
        onClick={() => (node.isDir ? onToggle(node.path) : onOpen(node.path))}
        onContextMenu={(event) => onContextMenu(event, node)}
        onFocus={() => onFocus(node.path)}
        role="treeitem"
        aria-expanded={node.isDir ? isOpen : undefined}
        aria-selected={active}
        tabIndex={focusedPath === node.path ? 0 : -1}
      >
        <span className="tree-chevron">
          {node.isDir ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </span>
        <span className="tree-icon">
          {node.isDir ? (isOpen ? <FolderOpen size={15} /> : <Folder size={15} />) : <FileText size={15} />}
        </span>
        <span className="tree-name" title={node.path}>{node.name}</span>
        <button
          className="tree-more"
          title="更多操作"
          aria-label={"更多操作：" + node.name}
          onClick={(event) => {
            event.stopPropagation();
            onContextMenu(event, node);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {node.isDir && isOpen && node.children.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          activePath={activePath}
          focusedPath={focusedPath}
          expanded={expanded}
          onToggle={onToggle}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          onFocus={onFocus}
        />
      ))}
    </>
  );
}

export default function Sidebar({
  workspace,
  tree,
  activePath,
  onOpenFolder,
  onOpenFile,
  onRefresh,
  onCreateFile,
  onCreateFolder,
  onRename,
  onTrash,
  onReveal,
  onClose
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useModalA11y(menuRef, () => setMenu(null), undefined, Boolean(menu));

  const workspaceName = workspace ? baseName(workspace) : "未打开工作区";
  const visibleNodes = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  useEffect(() => {
    if (!workspace) {
      setExpanded(new Set());
      return;
    }
    setExpanded((current) => {
      if (current.size > 0) return current;
      const next = new Set<string>();
      tree.filter((node) => node.isDir).forEach((node) => next.add(node.path));
      return next;
    });
  }, [workspace, tree]);

  useEffect(() => {
    setFocusedPath((current) => {
      if (activePath && visibleNodes.some((entry) => entry.node.path === activePath)) return activePath;
      if (current && visibleNodes.some((entry) => entry.node.path === current)) return current;
      return visibleNodes[0]?.node.path ?? null;
    });
  }, [activePath, visibleNodes]);

  useEffect(() => {
    if (!workspace || !query.trim()) {
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let disposed = false;
    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void searchWorkspace(workspace, query.trim())
        .then((matches) => {
          if (!disposed) setResults(matches);
        })
        .catch((reason) => {
          if (!disposed) {
            setResults([]);
            setSearchError(reason instanceof Error ? reason.message : String(reason));
          }
        })
        .finally(() => {
          if (!disposed) setSearching(false);
        });
    }, 280);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [workspace, query, searchNonce]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const blockShortcuts = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", blockShortcuts, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", blockShortcuts, true);
    };
  }, [menu]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const focusTreeRow = (path: string) => {
    setFocusedPath(path);
    window.requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>(".tree-row"))
        .find((element) => element.dataset.path === path);
      row?.focus();
    });
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row || !visibleNodes.length) return;
    const path = row.dataset.path;
    if (!path) return;
    const index = visibleNodes.findIndex((entry) => entry.node.path === path);
    if (index < 0) return;
    const entry = visibleNodes[index];
    const { node } = entry;
    const isOpen = expanded.has(path);

    if (event.key === "F10" && event.shiftKey || event.key === "ContextMenu") {
      event.preventDefault();
      openContextMenu(event, node);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown"
        ? Math.min(visibleNodes.length - 1, index + 1)
        : Math.max(0, index - 1);
      focusTreeRow(visibleNodes[nextIndex].node.path);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTreeRow(visibleNodes[0].node.path);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTreeRow(visibleNodes[visibleNodes.length - 1].node.path);
    } else if (event.key === "ArrowRight" && node.isDir) {
      event.preventDefault();
      if (!isOpen) toggle(path);
      else if (node.children[0]) focusTreeRow(node.children[0].path);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.isDir && isOpen) toggle(path);
      else if (entry.parentPath) focusTreeRow(entry.parentPath);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (node.isDir) toggle(path);
      else onOpenFile(path);
    }
  };

  const openContextMenu = (event: React.SyntheticEvent, node: FileNode) => {
    event.preventDefault();
    event.stopPropagation();
    const mouse = event as React.MouseEvent;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const keyboard = !mouse.clientX && !mouse.clientY;
    const width = 220;
    const height = node.isDir ? 226 : 184;
    const x = keyboard ? rect.left : mouse.clientX;
    const y = keyboard ? rect.bottom + 4 : mouse.clientY;
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      node
    });
  };

  const parentForCreate = useMemo(() => {
    if (!workspace) return "";
    if (!activePath) return workspace;
    const normalized = normalizeSlashes(activePath);
    const lower = normalized.toLowerCase();
    const isMarkdown = ["md", "markdown", "mdown", "mkd", "txt"]
      .some((extension) => lower.endsWith("." + extension));
    if (!isMarkdown) return activePath;
    const index = normalized.lastIndexOf("/");
    return index > 0 ? normalized.slice(0, index) : workspace;
  }, [workspace, activePath]);

  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="sidebar-kicker">写作空间</span>
          <strong title={workspace ?? undefined}>{workspaceName}</strong>
        </div>
        <button className="icon-button quiet" title="收起侧栏" onClick={onClose}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      {workspace ? (
        <>
          <div className="sidebar-actions">
            <button className="small-action" onClick={() => onCreateFile(parentForCreate)}>
              <FilePlus2 size={15} /> 文稿
            </button>
            <button className="small-action" onClick={() => onCreateFolder(parentForCreate)}>
              <FolderPlus size={15} /> 文件夹
            </button>
            <button className="icon-button quiet small" title="刷新文件树" onClick={onRefresh}>
              <RefreshCw size={14} />
            </button>
          </div>

          <label className="search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或正文"
              aria-label="搜索标题或正文"
              spellCheck={false}
            />
            {searching && <span className="search-pulse" />}
          </label>

          <div className="sidebar-scroll">
            {results !== null ? (
              <div className="search-results">
                <div className="tree-section-label" aria-live="polite">
                  {searching ? "搜索中…" : searchError ? "搜索失败" : results.length + " 个结果"}
                </div>
                {searchError ? (
                  <div className="sidebar-search-error" role="alert">
                    <AlertCircle size={18} />
                    <p>{searchError}</p>
                    <button className="small-action" onClick={() => setSearchNonce((value) => value + 1)}>
                      重试
                    </button>
                  </div>
                ) : (
                  <>
                    {results.map((node) => (
                      <button
                        key={node.path}
                        className="search-result"
                        onClick={() => onOpenFile(node.path)}
                        title={node.path}
                      >
                        <FileText size={14} />
                        <span>{node.name}</span>
                        <small>{normalizeSlashes(node.path).replace(normalizeSlashes(workspace) + "/", "")}</small>
                      </button>
                    ))}
                    {!searching && results.length === 0 && (
                      <p className="sidebar-empty-copy">没有匹配的文档。</p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="tree" role="tree" aria-label="工作区文件" onKeyDown={handleTreeKeyDown}>
                {tree.map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    activePath={activePath}
                    focusedPath={focusedPath}
                    expanded={expanded}
                    onToggle={toggle}
                    onOpen={onOpenFile}
                    onContextMenu={openContextMenu}
                    onFocus={setFocusedPath}
                  />
                ))}
                {tree.length === 0 && (
                  <p className="sidebar-empty-copy">这个文件夹里还没有 Markdown 文档。</p>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="sidebar-empty">
          <div className="sidebar-empty-mark"><FolderOpen size={30} strokeWidth={1.2} /></div>
          <h2>先选一个写作空间</h2>
          <p>打开包含 Markdown 的文件夹，文档树会自动出现在这里。</p>
          <button className="primary-button" onClick={onOpenFolder}>打开文件夹</button>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="open-folder-link" onClick={onOpenFolder}>
          <FolderOpen size={14} />
          {workspace ? "切换工作区" : "打开工作区"}
        </button>
        <span className="local-note"><HardDrive size={12} />本地存储</span>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={"操作：" + menu.node.name}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="context-menu-title">{menu.node.name}</div>
          {menu.node.isDir && (
            <>
              <button role="menuitem" onClick={() => { onCreateFile(menu.node.path); setMenu(null); }}>
                <FilePlus2 size={14} /> 新建文稿
              </button>
              <button role="menuitem" onClick={() => { onCreateFolder(menu.node.path); setMenu(null); }}>
                <FolderPlus size={14} /> 新建文件夹
              </button>
            </>
          )}
          <button role="menuitem" onClick={() => { onRename(menu.node); setMenu(null); }}>
            <Pencil size={14} /> 重命名
          </button>
          <button role="menuitem" onClick={() => { onReveal(menu.node); setMenu(null); }}>
            <ExternalLink size={14} /> 在资源管理器中显示
          </button>
          <button role="menuitem" className="danger" onClick={() => { onTrash(menu.node); setMenu(null); }}>
            <Trash2 size={14} /> 移到回收站
          </button>
        </div>
      )}
    </aside>
  );
}
