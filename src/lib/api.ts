import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FileNode, SaveResult, TextDocument } from "../types";

export async function readWorkspace(path: string): Promise<FileNode[]> {
  return invoke("read_workspace", { path });
}

export async function readTextFile(path: string): Promise<TextDocument> {
  return invoke("read_text_file", { path });
}

export async function writeTextFile(
  path: string,
  content: string,
  expected?: { modifiedMs: number; size: number }
): Promise<SaveResult> {
  return invoke("write_text_file", {
    path,
    content,
    expectedModifiedMs: expected?.modifiedMs,
    expectedSize: expected?.size
  });
}

export async function createFile(parent: string, name: string, content: string): Promise<string> {
  return invoke("create_file", { parent, name, content });
}

export async function createFolder(parent: string, name: string): Promise<string> {
  return invoke("create_folder", { parent, name });
}

export async function renamePath(path: string, newName: string): Promise<string> {
  return invoke("rename_path", { path, newName });
}

export async function trashPath(path: string): Promise<void> {
  return invoke("trash_path", { path });
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke("reveal_in_explorer", { path });
}

export async function writeExport(path: string, content: string): Promise<void> {
  return invoke("write_export", { path, content });
}

export async function writeExportBytes(path: string, bytes: number[]): Promise<void> {
  return invoke("write_export_bytes", { path, bytes });
}

export async function readExportImage(path: string): Promise<number[]> {
  return invoke("read_export_image", { path });
}

export async function searchWorkspace(root: string, query: string): Promise<FileNode[]> {
  return invoke("search_workspace", { root, query });
}

export async function saveImage(workspace: string, fileName: string, bytes: number[]): Promise<string> {
  return invoke("save_image", { workspace, fileName, bytes });
}

export async function pickFolder(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title: "打开工作区文件夹" });
  return typeof result === "string" ? result : null;
}

export async function pickMarkdownFile(): Promise<string | null> {
  const result = await open({
    multiple: false,
    title: "打开 Markdown 文档",
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }]
  });
  return typeof result === "string" ? result : null;
}

export async function pickImageFile(): Promise<string | null> {
  const result = await open({
    multiple: false,
    title: "插入图片",
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] }]
  });
  return typeof result === "string" ? result : null;
}

export async function saveMarkdownAs(defaultPath?: string): Promise<string | null> {
  const result = await save({
    title: "保存 Markdown 文档",
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  });
  return result ?? null;
}

export async function saveHtmlAs(defaultPath?: string): Promise<string | null> {
  const result = await save({
    title: "导出 HTML",
    defaultPath,
    filters: [{ name: "HTML", extensions: ["html"] }]
  });
  return result ?? null;
}

export async function openDefaultAppsSettings(): Promise<void> {
  await openUrl("ms-settings:defaultapps");
}

export async function workspaceWritable(path: string): Promise<boolean> {
  return invoke("workspace_writable", { path });
}

export interface LaunchOpenPayload {
  paths: string[];
  errors: string[];
}

/** Drain files that Windows asked us to open before the page was ready. */
export async function takePendingOpen(): Promise<LaunchOpenPayload> {
  return invoke("take_pending_open");
}

export async function saveDocxAs(defaultPath?: string): Promise<string | null> {
  const result = await save({
    title: "导出 Word 文档",
    defaultPath,
    filters: [{ name: "Word 文档", extensions: ["docx"] }]
  });
  return result ?? null;
}
