import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";

interface WindowControlsProps {
  onClose: () => void;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function WindowControls({ onClose }: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    const appWindow = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;

    const syncMaximized = () => {
      void appWindow.isMaximized()
        .then((value) => {
          if (!alive) return;
          setMaximized(value);
          document.documentElement.dataset.windowMaximized = value ? "true" : "false";
        })
        .catch(() => undefined);
    };

    syncMaximized();
    void appWindow.onResized(syncMaximized)
      .then((stop) => { unlisten = stop; })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  if (!inTauri()) return null;
  const appWindow = getCurrentWindow();

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="window-control window-minimize"
        title="最小化"
        aria-label="最小化"
        onClick={() => { void appWindow.minimize().catch(() => undefined); }}
      >
        <Minus size={14} strokeWidth={1.7} />
      </button>
      <button
        type="button"
        className="window-control window-maximize"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
        onClick={() => { void appWindow.toggleMaximize().catch(() => undefined); }}
      >
        {maximized ? <Minimize2 size={13} strokeWidth={1.7} /> : <Maximize2 size={13} strokeWidth={1.7} />}
      </button>
      <button
        type="button"
        className="window-control window-close"
        title="关闭"
        aria-label="关闭窗口"
        onClick={onClose}
      >
        <X size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}
