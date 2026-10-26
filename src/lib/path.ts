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

export function resolvePath(base: string, child: string): string {
  const raw = normalizeSlashes(child);
  const absolute = /^(?:[A-Za-z]:[\/]|\/)/.test(raw);
  const combined = absolute || !base ? raw : joinPath(base, raw);
  const normalized = normalizeSlashes(combined);
  const drive = /^[A-Za-z]:/.exec(normalized)?.[0] ?? "";
  const rooted = normalized.slice(drive.length).startsWith("/");
  const parts: string[] = [];
  for (const part of normalized.slice(drive.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== ".." || !rooted) parts.push(part);
  }
  return drive + (rooted ? "/" : "") + parts.join("/");
}

export function relativePath(fromDirectory: string, target: string): string {
  const from = resolvePath("", fromDirectory);
  const destination = resolvePath("", target);
  if (from.slice(0, 2).toLowerCase() !== destination.slice(0, 2).toLowerCase()) return destination;
  const fromParts = from.split("/").filter(Boolean);
  const targetParts = destination.split("/").filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < targetParts.length
    && fromParts[common].toLowerCase() === targetParts[common].toLowerCase()) common += 1;
  return [...fromParts.slice(common).map(() => ".."), ...targetParts.slice(common)].join("/");
}

export function decodeAssetPath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function documentAssetPath(documentPath: string | null, workspace: string | null, url: string): string {
  const decoded = decodeAssetPath(url);
  const base = documentPath ? dirName(documentPath) : workspace;
  return base ? resolvePath(base, decoded) : decoded;
}

export function markdownAssetPath(documentPath: string | null, workspace: string, savedPath: string): string {
  if (!documentPath) return markdownLinkPath(savedPath);
  return relativePath(dirName(documentPath), resolvePath(workspace, savedPath));
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
