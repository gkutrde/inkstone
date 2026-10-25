export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface TextDocument {
  path: string;
  name: string;
  content: string;
  modifiedMs: number;
  size: number;
}

export type EditorMode = "rich" | "source";
export type ThemeName = "paper" | "sepia" | "night";

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  content: string;
  savedContent: string;
  mode: EditorMode;
  modifiedMs?: number;
  size?: number;
}

export interface OutlineItem {
  text: string;
  level: number;
  line: number;
}

export interface Settings {
  theme: ThemeName;
  fontSize: number;
  measure: number;
  showSidebar: boolean;
  showOutline: boolean;
  autoSave: boolean;
  reduceTransparency: boolean;
}

export interface SaveResult {
  modifiedMs: number;
  size: number;
}
