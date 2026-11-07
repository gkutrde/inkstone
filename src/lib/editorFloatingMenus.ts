import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";

/** Keep Crepe's own language picker/state, but escape rounded scroll-container clipping. */
export function keepEditorLanguageMenusVisible(root: HTMLElement): () => void {
  const managed = new Map<HTMLElement, () => void>();
  let frame = 0;
  const refresh = () => {
    frame = 0;
    const visible = new Set<HTMLElement>();
    root.querySelectorAll<HTMLElement>(".language-picker").forEach((menu) => {
      const list = menu.querySelector<HTMLElement>(".language-list");
      const wrapper = menu.querySelector<HTMLElement>(".list-wrapper");
      const trigger = menu.closest(".milkdown-code-block")?.querySelector<HTMLElement>(".language-button");
      if (!list || !wrapper || !trigger || !menu.isConnected) return;
      visible.add(menu);
      if (managed.has(menu)) return;
      const keys = ["position", "inset", "margin", "border", "padding", "background", "color", "overflow", "left", "top"];
      const original = keys.map((key) => [key, menu.style.getPropertyValue(key), menu.style.getPropertyPriority(key)]);
      const originalHeight = list.style.maxHeight;
      const cap = Number.parseFloat(getComputedStyle(list).maxHeight) || 410;
      const previousPopover = menu.getAttribute("popover");
      const supportsPopover = typeof menu.showPopover === "function";
      const focused = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement)
        ? document.activeElement : null;
      Object.assign(menu.style, { position: "fixed", inset: "auto", margin: "0", border: "0", padding: "0", background: "transparent", color: "inherit", overflow: "visible" });
      if (supportsPopover) {
        menu.setAttribute("popover", "manual");
        menu.showPopover();
        focused?.focus({ preventScroll: true });
      }
      const update = () => {
        void computePosition(trigger, menu, {
          strategy: "fixed",
          placement: "bottom-start",
          middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({
            padding: 8,
            apply({ availableHeight }) {
              const current = menu.querySelector<HTMLElement>(".language-list");
              const box = menu.querySelector<HTMLElement>(".list-wrapper");
              if (!current || !box) return;
              const chrome = box.offsetHeight - current.offsetHeight;
              const height = Math.max(0, Math.min(cap, availableHeight - chrome));
              const value = height + "px";
              if (current.style.maxHeight !== value) current.style.maxHeight = value;
            }
          })]
        }).then(({ x, y }) => {
          if (!managed.has(menu) || !menu.isConnected) return;
          menu.style.left = x + "px";
          menu.style.top = y + "px";
        }).catch((error) => {
          if (managed.has(menu) && menu.isConnected) console.error("Language menu positioning failed", error);
        });
      };
      const stop = autoUpdate(trigger, menu, update);
      let focusFrame = 0;
      const onFocus = () => {
        cancelAnimationFrame(focusFrame);
        focusFrame = requestAnimationFrame(() => {
          const active = document.activeElement;
          if (menu.querySelector(".list-wrapper") && active && !menu.contains(active) && !trigger.contains(active)) trigger.click();
        });
      };
      document.addEventListener("focusin", onFocus, true);
      managed.set(menu, () => {
        stop();
        cancelAnimationFrame(focusFrame);
        document.removeEventListener("focusin", onFocus, true);
        if (supportsPopover && menu.matches(":popover-open")) menu.hidePopover();
        if (previousPopover === null) menu.removeAttribute("popover");
        else menu.setAttribute("popover", previousPopover);
        for (const [key, value, priority] of original) {
          if (value) menu.style.setProperty(key!, value, priority);
          else menu.style.removeProperty(key!);
        }
        list.style.maxHeight = originalHeight;
      });
    });
    for (const [menu, cleanup] of managed) {
      if (!visible.has(menu)) { cleanup(); managed.delete(menu); }
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest(".language-picker, .language-button")) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(".language-picker") || node.querySelector(".language-picker")));
    })) schedule();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "data-expanded"] });
  refresh();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    for (const cleanup of managed.values()) cleanup();
    managed.clear();
  };
}
