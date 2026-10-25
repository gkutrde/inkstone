import { convertFileSrc } from "@tauri-apps/api/core";

export function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

export function baseName(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

export function dirName(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

export function joinPath(base: string, child: string): string {
  let normalizedBase = normalizeSlashes(base);
  while (normalizedBase.endsWith("/")) normalizedBase = normalizedBase.slice(0, -1);
  return normalizedBase + "/" + normalizeSlashes(child).replace(/^\/+/, "");
}

export function toFileUrlPath(path: string): string {
  return convertFileSrc(path);
}

export function markdownLinkPath(path: string): string {
  return normalizeSlashes(path);
}

export function withMarkdownExtension(path: string): string {
  return /\.[A-Za-z0-9]+$/.test(path) ? path : path + ".md";
}
