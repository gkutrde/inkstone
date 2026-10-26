import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, Replace, X } from "lucide-react";

interface FindBarProps {
  query: string;
  replacement: string;
  matchCount: number;
  focusSignal: number;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export default function FindBar({
  query,
  replacement,
  matchCount,
  focusSignal,
  onQueryChange,
  onReplacementChange,
  onNext,
  onPrevious,
  onReplaceAll,
  onClose
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  return (
    <div className="find-bar" role="dialog" aria-label="查找和替换">
      <div className="find-row">
        <input
          ref={inputRef}
          value={query}
          placeholder="查找"
          aria-label="查找内容"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) onPrevious();
              else onNext();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <span className="find-count" aria-live="polite">{query ? matchCount + " 处" : "—"}</span>
        <button className="icon-button quiet" title="上一处 (Shift+Enter)" onClick={onPrevious}>
          <ArrowUp size={15} />
        </button>
        <button className="icon-button quiet" title="下一处 (Enter)" onClick={onNext}>
          <ArrowDown size={15} />
        </button>
        <button className="icon-button quiet" title="关闭 (Esc)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="find-row replace-row">
        <input
          value={replacement}
          placeholder="替换为"
          aria-label="替换为"
          onChange={(event) => onReplacementChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onReplaceAll();
            }
          }}
        />
        <button className="text-button compact" onClick={onReplaceAll} disabled={!query}>
          <Replace size={14} /> 全部替换
        </button>
      </div>
    </div>
  );
}
