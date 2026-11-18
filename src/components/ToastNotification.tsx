import { useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "./IosIcons";
import { useAnimatedPresence } from "../lib/useAnimatedClose";

export interface ToastNotificationState {
  message: string;
  kind: "info" | "success" | "error";
}

interface ToastNotificationProps {
  toast: ToastNotificationState | null;
  onClose: () => void;
}

export default function ToastNotification({ toast, onClose }: ToastNotificationProps) {
  const presence = useAnimatedPresence(Boolean(toast));
  const lastToastRef = useRef<ToastNotificationState | null>(null);

  useEffect(() => {
    if (toast) lastToastRef.current = toast;
  }, [toast]);

  const visibleToast = toast ?? lastToastRef.current;
  if (!presence.present || !visibleToast) return null;

  return (
    <div
      className={"toast " + visibleToast.kind}
      data-state={presence.closing ? "closing" : "open"}
      role={visibleToast.kind === "error" ? "alert" : "status"}
      aria-live={visibleToast.kind === "error" ? "assertive" : "polite"}
    >
      <span className="toast-icon">
        {visibleToast.kind === "success"
          ? <CheckCircle2 size={16} />
          : visibleToast.kind === "error"
            ? <AlertCircle size={16} />
            : <Info size={16} />}
      </span>
      <span className="toast-message">{visibleToast.message}</span>
      <button className="toast-close" aria-label="关闭通知" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
