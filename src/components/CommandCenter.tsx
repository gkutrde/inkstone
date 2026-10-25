import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock3, Command as CommandIcon, CornerDownLeft, Search } from "lucide-react";
import { useModalA11y } from "../lib/useModalA11y";

export interface CommandAction {
  id: string;
  label: string;
  description?: string;
  section: string;
  shortcut?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

interface CommandCenterProps {
  actions: CommandAction[];
  onClose: () => void;
}

const RECENT_KEY = "inkstone.command.recent.v1";

function loadRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 4) : [];
  } catch {
    return [];
  }
}

function fuzzyScore(action: CommandAction, query: string): number | null {
  if (!query) return 0;
  const label = action.label.toLocaleLowerCase();
  const source = (action.label + " " + (action.description ?? "") + " " + (action.keywords ?? ""))
    .toLocaleLowerCase();
  let cursor = -1;
  let score = 0;
  for (const character of query) {
    const found = source.indexOf(character, cursor + 1);
    if (found < 0) return null;
    score += found - cursor - 1;
    cursor = found;
  }
  if (label.startsWith(query)) score -= 24;
  else if (label.includes(query)) score -= 12;
  return score + source.length * 0.01;
}

export default function CommandCenter({ actions, onClose }: CommandCenterProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, inputRef);

  const ranked = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
    const recentIndex = new Map(recent.map((id, index) => [id, index]));
    return actions
      .map((action, index) => ({
        action,
        index,
        score: fuzzyScore(action, normalized),
        recent: recentIndex.get(action.id) ?? Number.POSITIVE_INFINITY
      }))
      .filter((item) => item.score !== null)
      .sort((left, right) => {
        if (!normalized && left.recent !== right.recent) return left.recent - right.recent;
        return left.score! - right.score! || left.index - right.index;
      })
      .map((item) => ({
        ...item,
        isRecent: !normalized && item.recent < 4
      }));
  }, [actions, query, recent]);

  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    if (activeIndex >= ranked.length) setActiveIndex(Math.max(0, ranked.length - 1));
  }, [activeIndex, ranked.length]);

  const execute = (index: number) => {
    const selected = ranked[index];
    if (!selected) return;
    const next = [selected.action.id, ...recent.filter((id) => id !== selected.action.id)].slice(0, 4);
    setRecent(next);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    onClose();
    window.setTimeout(selected.action.run, 0);
  };

  const active = ranked[activeIndex];
  let previousSection = "";

  return (
    <div className="command-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="command-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="命令中心"
        tabIndex={-1}
      >
        <div className="command-search-row">
          <CommandIcon size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索命令、文稿操作或设置…"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-listbox"
            aria-autocomplete="list"
            aria-activedescendant={active ? "command-option-" + active.action.id : undefined}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!ranked.length) return;
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((current) => (current + delta + ranked.length) % ranked.length);
              } else if (event.key === "Home" && ranked.length) {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End" && ranked.length) {
                event.preventDefault();
                setActiveIndex(ranked.length - 1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(activeIndex);
              }
            }}
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div className="command-results" id="command-listbox" role="listbox" aria-label="可用命令">
          {ranked.map((item, index) => {
            const section = item.isRecent ? "最近使用" : item.action.section;
            const showSection = section !== previousSection;
            previousSection = section;
            return (
              <div key={item.action.id}>
                {showSection && <div className="command-section-label">{section}</div>}
                <button
                  id={"command-option-" + item.action.id}
                  className={"command-option" + (index === activeIndex ? " is-active" : "")}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => execute(index)}
                >
                  <span className="command-option-icon">
                    {item.isRecent ? <Clock3 size={16} /> : item.action.icon}
                  </span>
                  <span className="command-option-copy">
                    <strong>{item.action.label}</strong>
                    {item.action.description && <small>{item.action.description}</small>}
                  </span>
                  {item.action.shortcut
                    ? <kbd>{item.action.shortcut}</kbd>
                    : index === activeIndex
                      ? <CornerDownLeft size={14} />
                      : null}
                </button>
              </div>
            );
          })}
          {!ranked.length && (
            <div className="command-empty">
              <Search size={20} />
              <strong>没有匹配的命令</strong>
              <span>试试“保存”“导出”“主题”或“专注”。</span>
            </div>
          )}
        </div>
        <div className="command-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
