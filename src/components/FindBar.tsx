import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, Replace, X } from "./IosIcons";
import { isImeKeyEvent } from "../lib/keyboard";
import { useAnimatedClose } from "../lib/useAnimatedClose";

interface FindBarProps {
  query: string;
  replacement: string;
  matchCount: number;
  focusSignal: number;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onReplaceCurrent: () => void;
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
  onReplaceCurrent,
  onReplaceAll,
  onClose
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { closing, requestClose } = useAnimatedClose(onClose, 170);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  return (
    <div className="find-bar" data-state={closing ? "closing" : "open"} role="dialog" aria-label="查找和替换">
      <div className="find-row">
        <input
          ref={inputRef}
          value={query}
          placeholder="查找"
          aria-label="查找内容"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKeyEvent(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) onPrevious();
              else onNext();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              requestClose();
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
        <button className="icon-button quiet" title="关闭 (Esc)" onClick={requestClose}>
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
            if (isImeKeyEvent(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              requestClose();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onReplaceAll();
            }
          }}
        />
        <button className="text-button compact" onClick={onReplaceCurrent} disabled={!query}>
          <Replace size={14} /> 替换
        </button>
        <button className="text-button compact" onClick={onReplaceAll} disabled={!query}>
          <Replace size={14} /> 全部替换
        </button>
      </div>
    </div>
  );
}
