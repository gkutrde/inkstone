import { useEffect, useRef, type RefObject } from "react";
import { isImeKeyEvent } from "./keyboard";

const MENU_ITEM = "[role='menuitem']:not([disabled])";

function menuItems(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(MENU_ITEM))
    .filter((element) => element.getClientRects().length > 0);
}

/** WAI-ARIA menu keyboard flow with non-stealing focus restoration. */
export function useMenuA11y(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusItem = (item: HTMLElement | undefined) => {
      if (!item) return;
      item.focus();
      item.scrollIntoView({ block: "nearest" });
    };
    const frame = window.requestAnimationFrame(() => {
      const items = menuItems(containerRef.current);
      focusItem(items[0] ?? containerRef.current ?? undefined);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyEvent(event)) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const container = containerRef.current;
      if (!container?.contains(document.activeElement)) return;
      if (event.key === "Tab") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = menuItems(container);
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(document.activeElement as HTMLElement);
      let index = current;
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = items.length - 1;
      else if (event.key === "ArrowDown") index = current < 0 ? 0 : (current + 1) % items.length;
      else index = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      focusItem(items[index]);
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      const active = document.activeElement;
      if (containerRef.current?.contains(active) || active === document.body) previous?.focus();
    };
  }, [containerRef, enabled]);
}
