import { useRef } from "react";
import { X } from "lucide-react";
import { useModalA11y } from "../lib/useModalA11y";

const groups = [
  {
    title: "命令与导航",
    items: [
      ["Ctrl K", "打开命令中心"],
      ["Ctrl N", "新建文稿"],
      ["Ctrl O", "打开文件"],
      ["Ctrl Shift O", "打开工作区"],
      ["Ctrl W", "关闭当前标签"],
      ["Ctrl F", "查找与替换"]
    ]
  },
  {
    title: "写作与视图",
    items: [
      ["Ctrl S", "保存文稿"],
      ["Ctrl Shift S", "另存为"],
      ["Ctrl E / Ctrl /", "切换编辑与源码"],
      ["Ctrl Shift D", "切换专注写作"],
      ["F3", "下一个匹配"]
    ]
  },
  {
    title: "导出与帮助",
    items: [
      ["Ctrl P", "打印或另存 PDF"],
      ["F1", "打开快捷键帮助"],
      ["Esc", "关闭弹层或对话框"]
    ]
  }
];

export default function ShortcutDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="shortcut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-title"
        tabIndex={-1}
      >
        <div className="prompt-heading">
          <div>
            <h2 id="shortcut-title">键盘快捷键</h2>
            <p className="prompt-description">不用离开键盘，也能完成主要写作操作。</p>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </div>
        <div className="shortcut-groups">
          {groups.map((group) => (
            <section key={group.title} className="shortcut-group">
              <h3>{group.title}</h3>
              {group.items.map(([keys, label]) => (
                <div className="shortcut-row" key={keys}>
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
