import { baseName, normalizeSlashes } from "./path";

export interface RecentEntry {
  path: string;
  name: string;
  at: number;
}

function comparable(path: string): string {
  return normalizeSlashes(path).toLowerCase();
}

export function isPathAffected(path: string, target: string, isDirectory: boolean): boolean {
  const candidate = comparable(path);
  const normalizedTarget = comparable(target);
  return candidate === normalizedTarget || (isDirectory && candidate.startsWith(normalizedTarget + "/"));
}

export function remapAffectedPath(path: string, oldPath: string, newPath: string, isDirectory: boolean): string {
  const normalized = normalizeSlashes(path);
  const normalizedOld = normalizeSlashes(oldPath);
  const normalizedNew = normalizeSlashes(newPath);
  if (comparable(path) === comparable(oldPath)) return normalizedNew;
  if (isDirectory && comparable(path).startsWith(comparable(oldPath) + "/")) {
    return normalizedNew + normalized.slice(normalizedOld.length);
  }
  return path;
}

export function renameRecentEntries(
  entries: RecentEntry[],
  oldPath: string,
  newPath: string,
  isDirectory: boolean
): RecentEntry[] {
  return entries.map((item) => {
    const path = remapAffectedPath(item.path, oldPath, newPath, isDirectory);
    return path === item.path ? item : { ...item, path, name: baseName(path) };
  });
}

export function removeRecentEntries(entries: RecentEntry[], target: string, isDirectory: boolean): RecentEntry[] {
  return entries.filter((item) => !isPathAffected(item.path, target, isDirectory));
}
