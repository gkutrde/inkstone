import {
  completionStatus,
  currentCompletions,
  selectedCompletion,
  startCompletion,
  type Completion
} from "@codemirror/autocomplete";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";

type CodeScope = (state: EditorState, pos: number) => boolean;
type PreviewCompletion = Completion & { ghostText?: string };

interface GhostValue {
  from: number;
  text: string;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-completion";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
}

const ghostEffect = StateEffect.define<GhostValue | null>();
const ghostDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(ghostEffect)) continue;
      if (!effect.value) return Decoration.none;
      const { from, text } = effect.value;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(from)
      ]);
    }
    if (tr.docChanged || tr.selection !== tr.startState.selection) return Decoration.none;
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field)
});

function previewFor(completion: Completion | null): string | null {
  if (!completion) return null;
  const custom = (completion as PreviewCompletion).ghostText;
  if (typeof custom === "string") return custom;
  // A function apply() may insert more than its label, so never fake its preview.
  if (typeof completion.apply === "function") return null;
  return typeof completion.apply === "string" ? completion.apply : completion.label;
}

function remainingPreview(state: EditorState, preview: string): string | null {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(Math.max(line.from, pos - 120), pos);
  const limit = Math.min(before.length, preview.length);
  for (let length = limit; length > 0; length -= 1) {
    const prefix = before.slice(-length);
    if (preview.startsWith(prefix)) {
      const rest = preview.slice(prefix.length);
      return rest ? rest : null;
    }
  }
  return null;
}

class GhostPreviewPlugin {
  private timer: number | null = null;
  private awaiting = false;
  private queued = false;
  private destroyed = false;
  private signature = "";
  private readonly onCompositionEnd: () => void;

  constructor(private view: EditorView, private enabled: CodeScope) {
    this.onCompositionEnd = () => this.schedule();
    view.dom.addEventListener("compositionend", this.onCompositionEnd);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.signature = "";
      this.awaiting = false;
      this.schedule();
    } else if (update.selectionSet) {
      this.signature = "";
      this.awaiting = false;
      this.cancelTimer();
    }
    this.queueSync();
  }

  private cancelTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.destroyed) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.awaiting = true;
      this.sync();
    }, 500);
  }

  private queueSync(): void {
    if (this.queued || this.destroyed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.sync();
    });
  }

  private clearPreview(): void {
    if (!this.signature) return;
    this.signature = "";
    this.view.dispatch({ effects: ghostEffect.of(null) });
  }

  private sync(): void {
    if (this.destroyed) return;
    const { state } = this.view;
    const pos = state.selection.main.head;
    if (this.view.composing || !this.view.hasFocus || !this.enabled(state, pos)) {
      this.awaiting = false;
      this.clearPreview();
      return;
    }
    const status = completionStatus(state);
    if (this.awaiting) {
      if (status === null) {
        startCompletion(this.view);
        return;
      }
      if (status === "pending") return;
      const completion = selectedCompletion(state) ?? currentCompletions(state)[0] ?? null;
      const preview = previewFor(completion);
      const rest = preview ? remainingPreview(state, preview) : null;
      this.awaiting = false;
      if (rest) this.setPreview(pos, rest);
      else this.clearPreview();
      return;
    }
    if (!this.signature) return;
    if (status !== "active") {
      this.clearPreview();
      return;
    }
    const completion = selectedCompletion(state) ?? currentCompletions(state)[0] ?? null;
    const preview = previewFor(completion);
    const rest = preview ? remainingPreview(state, preview) : null;
    if (rest) this.setPreview(pos, rest);
    else this.clearPreview();
  }

  private setPreview(from: number, text: string): void {
    const signature = from + ":" + text;
    if (signature === this.signature) return;
    this.signature = signature;
    this.view.dispatch({ effects: ghostEffect.of({ from, text }) });
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelTimer();
    this.view.dom.removeEventListener("compositionend", this.onCompositionEnd);
  }
}

/** Show the selected completion as a non-document, multi-line ghost preview. */
export function ghostCompletionPreview(enabled: CodeScope): Extension {
  return [
    ghostDecorations,
    ViewPlugin.define((view) => new GhostPreviewPlugin(view, enabled))
  ];
}
