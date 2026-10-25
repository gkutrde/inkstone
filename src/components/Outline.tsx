import { ListTree, X } from "lucide-react";
import type { OutlineItem } from "../types";

interface OutlineProps {
  items: OutlineItem[];
  onJump: (item: OutlineItem, index: number) => void;
  onClose: () => void;
  wordCount: number;
  minutes: number;
}

export default function Outline({ items, onJump, onClose, wordCount, minutes }: OutlineProps) {
  return (
    <aside className="outline-panel">
      <div className="outline-heading">
        <div className="outline-title">
          <ListTree size={16} />
          <span>大纲</span>
        </div>
        <button className="icon-button quiet" title="收起大纲" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="outline-scroll">
        {items.length ? (
          items.map((item, index) => (
            <button
              key={item.line + "-" + index}
              className={"outline-item level-" + item.level}
              style={{ paddingLeft: 14 + (item.level - 1) * 13 }}
              onClick={() => onJump(item, index)}
              title={item.text}
            >
              <span className="outline-rule" />
              <span>{item.text}</span>
            </button>
          ))
        ) : (
          <p className="outline-empty">用 # 写一个标题，大纲会在这里展开。</p>
        )}
      </div>
      <div className="outline-stats">
        <div><strong>{wordCount.toLocaleString()}</strong><span>字词</span></div>
        <div><strong>{minutes}</strong><span>分钟阅读</span></div>
      </div>
    </aside>
  );
}
