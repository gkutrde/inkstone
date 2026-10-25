import type { Tab } from "../types";

const DRAFTS_KEY = "inkstone.drafts.v1";
const MAX_DRAFTS = 20;

export function loadDrafts(): Tab[] {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_DRAFTS).flatMap((value): Tab[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Partial<Tab>;
      if (item.path !== null || typeof item.content !== "string" || !item.content) return [];
      if (typeof item.id !== "string" || !item.id) return [];
      return [{
        id: item.id,
        path: null,
        name: typeof item.name === "string" && item.name.trim() ? item.name : "未命名",
        content: item.content,
        savedContent: "\u0000",
        mode: item.mode === "source" ? "source" : "rich"
      }];
    });
  } catch {
    return [];
  }
}

export function persistDrafts(tabs: Tab[]): boolean {
  try {
    const drafts = tabs
      .filter((tab) => tab.path === null && tab.content.length > 0)
      .slice(0, MAX_DRAFTS)
      .map((tab) => ({ ...tab, savedContent: "\u0000" }));
    if (drafts.length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(DRAFTS_KEY);
    return true;
  } catch {
    return false;
  }
}
