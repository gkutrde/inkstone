import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useModalA11y } from "../lib/useModalA11y";

export interface PromptRequest {
  title: string;
  description?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
}

interface PromptDialogProps {
  request: PromptRequest;
  onClose: () => void;
}

export default function PromptDialog({ request, onClose }: PromptDialogProps) {
  const [value, setValue] = useState(request.initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  useModalA11y(dialogRef, onClose, inputRef);

  useEffect(() => {
    setValue(request.initialValue ?? "");
    setError(null);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
  }, [request]);

  const submit = async () => {
    if (!value.trim()) {
      setError("名称不能为空。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request.onSubmit(value.trim());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        ref={dialogRef}
        className="prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="prompt-heading">
          <div>
            <h2 id="prompt-title">{request.title}</h2>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </div>
        {request.description && <p className="prompt-description">{request.description}</p>}
        <input
          ref={inputRef}
          className="prompt-input"
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "prompt-error" : undefined}
        />
        {error && <p className="prompt-error" id="prompt-error" role="alert">{error}</p>}
        <div className="prompt-actions">
          <button type="button" className="text-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "处理中…" : (request.confirmLabel ?? "确认")}
          </button>
        </div>
      </form>
    </div>
  );
}
