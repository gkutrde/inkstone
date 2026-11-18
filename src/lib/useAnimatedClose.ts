import { useCallback, useEffect, useRef, useState } from "react";

export const OVERLAY_EXIT_MS = 180;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Keeps an externally controlled popover mounted for its short exit transition. */
export function useAnimatedPresence(open: boolean, duration = OVERLAY_EXIT_MS) {
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setPresent(true);
      setClosing(false);
      return;
    }
    if (!present) {
      setClosing(false);
      return;
    }
    if (duration <= 0 || prefersReducedMotion()) {
      setPresent(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setPresent(false);
      setClosing(false);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [open, present, duration]);

  return { present, closing };
}

/** Converts a close request into one idempotent, motion-aware close lifecycle. */
export function useAnimatedClose(onClose: () => void, duration = OVERLAY_EXIT_MS) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (duration <= 0 || prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onCloseRef.current();
    }, duration);
  }, [duration]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { closing, requestClose };
}
