import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeName } from "../types";

const NATIVE_GLASS_ATTRIBUTE = "nativeGlass";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const EFFECT_TINTS: Record<ThemeName, string> = {
  paper: "#f7f3ea52",
  sepia: "#efe2c752",
  night: "#0c100e66"
};

function setNativeGlassAttribute(enabled: boolean): void {
  if (enabled) document.documentElement.dataset[NATIVE_GLASS_ATTRIBUTE] = "true";
  else delete document.documentElement.dataset[NATIVE_GLASS_ATTRIBUTE];
}

/**
 * Windows 10/11 native backdrop for the app shell.
 *
 * Mica is preferred on Windows 11, Acrylic is the Windows 10 fallback, and Blur
 * is the last resort. The CSS WebView background is only made transparent after
 * setEffects resolves; otherwise the existing in-app ambient material remains
 * visible and the window never turns into an empty transparent shell.
 */
export async function syncDesktopGlass(reduceTransparency: boolean, theme: ThemeName): Promise<boolean> {
  if (!inTauri()) {
    setNativeGlassAttribute(false);
    return false;
  }

  const appWindow = getCurrentWindow();
  if (reduceTransparency) {
    try {
      await appWindow.clearEffects();
    } catch {
      /* fall through to the opaque CSS material */
    }
    setNativeGlassAttribute(false);
    return false;
  }

  const attempts = [
    [Effect.Mica, Effect.Acrylic, Effect.Blur],
    [Effect.Acrylic, Effect.Blur],
    [Effect.Blur]
  ];

  for (const effects of attempts) {
    try {
      await appWindow.setEffects({
        effects,
        color: EFFECT_TINTS[theme]
      });
      setNativeGlassAttribute(true);
      return true;
    } catch {
      /* try the next supported Windows backdrop */
    }
  }

  setNativeGlassAttribute(false);
  return false;
}
