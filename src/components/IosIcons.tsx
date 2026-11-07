import type { SVGProps } from "react";

/** Standard SVG props, plus the square-size shorthand used by the app. */
export type IosIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

type IconPath = string | {
  readonly d: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly opacity?: number;
};

/**
 * Original Inkstone artwork: a shared 24-point grid and light, rounded strokes.
 * These are independently drawn symbols, not Apple or Lucide assets.
 * SVG props (including React 19 refs) are passed through; explicit attributes
 * may override the decorative aria-hidden/focusable defaults when necessary.
 */
function createIcon(name: string, paths: readonly IconPath[]) {
  function Icon({
    size = 24,
    strokeWidth = 1.7,
    color = "currentColor",
    children,
    ...svgProps
  }: IosIconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        color={color}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={true}
        focusable="false"
        {...svgProps}
      >
        {paths.map((path, index) => (
          typeof path === "string"
            ? <path key={index} d={path} />
            : <path key={index} {...path} />
        ))}
        {children}
      </svg>
    );
  }

  Icon.displayName = name;
  return Icon;
}

const circleOutline = "M20.4 12a8.4 8.4 0 1 1-16.8 0 8.4 8.4 0 0 1 16.8 0Z";
const documentOutline = "M13.6 3.2H7.1C5.9 3.2 5 4.1 5 5.3v13.4c0 1.2.9 2.1 2.1 2.1h9.8c1.2 0 2.1-.9 2.1-2.1V8.6Z";
const documentFold = "M13.6 3.5v3.5c0 1 .6 1.6 1.6 1.6h3.5";
const folderOutline = "M3.1 8.6V6.7c0-1.2.9-2.1 2.1-2.1h4.2c.7 0 1.2.3 1.6.8l1.2 1.4h6.6c1.2 0 2.1.9 2.1 2.1v8.8c0 1.2-.9 2.1-2.1 2.1H5.2c-1.2 0-2.1-.9-2.1-2.1V8.6Z";
const panelOutline = "M5.5 4.6h13c1.3 0 2.3 1 2.3 2.3v10.2c0 1.3-1 2.3-2.3 2.3h-13c-1.3 0-2.3-1-2.3-2.3V6.9c0-1.3 1-2.3 2.3-2.3Z";
const checkedCircle: readonly IconPath[] = [
  circleOutline,
  "M8 12.1l2.7 2.9 5.5-5.8"
];

export const AlertCircle = createIcon("AlertCircle", [
  circleOutline,
  "M12 7.3v5.2M12 16.4h.02"
]);

export const ArrowDown = createIcon("ArrowDown", [
  "M12 4.8v14.4M6.1 13.3l5.9 5.9 5.9-5.9"
]);

export const ArrowLeft = createIcon("ArrowLeft", [
  "M19.2 12H4.8M10.7 6.1 4.8 12l5.9 5.9"
]);

export const ArrowRight = createIcon("ArrowRight", [
  "M4.8 12h14.4M13.3 6.1l5.9 5.9-5.9 5.9"
]);

export const ArrowUp = createIcon("ArrowUp", [
  "M12 19.2V4.8M6.1 10.7 12 4.8l5.9 5.9"
]);

export const ArrowUpRight = createIcon("ArrowUpRight", [
  "M6.1 17.9 17.9 6.1M6.8 6.1h11.1v11.1"
]);

export const BookOpen = createIcon("BookOpen", [
  "M12 5.8c-2.4-1.6-5.8-2-8.6-1v13.1c2.8-1 5.9-.7 8.6 1 2.7-1.7 5.8-2 8.6-1V4.8c-2.8-1-6.2-.6-8.6 1ZM12 5.8v13.1",
  "M6.4 8.6c.9-.1 1.8.1 2.7.4M14.9 9c.9-.3 1.8-.5 2.7-.4"
]);

export const CheckCircle2 = createIcon("CheckCircle2", checkedCircle);

export const ChevronDown = createIcon("ChevronDown", [
  "M5.8 9.2 12 15.4l6.2-6.2"
]);

export const ChevronRight = createIcon("ChevronRight", [
  "M9.2 5.8 15.4 12l-6.2 6.2"
]);

export const CircleCheck = createIcon("CircleCheck", checkedCircle);

export const Clock3 = createIcon("Clock3", [
  circleOutline,
  "M12 6.9v5.3h4.2"
]);

export const Command = createIcon("Command", [
  "M8.2 8.2h7.6v7.6H8.2Z",
  "M8.2 8.2H5.8a2.4 2.4 0 1 1 2.4-2.4v2.4",
  "M15.8 8.2V5.8a2.4 2.4 0 1 1 2.4 2.4h-2.4",
  "M15.8 15.8h2.4a2.4 2.4 0 1 1-2.4 2.4v-2.4",
  "M8.2 15.8v2.4a2.4 2.4 0 1 1-2.4-2.4h2.4"
]);

export const CornerDownLeft = createIcon("CornerDownLeft", [
  "M19.4 5.3v6.1c0 1.7-1.4 3.1-3.1 3.1H4.6M9.2 9.9l-4.6 4.6 4.6 4.6"
]);

export const Download = createIcon("Download", [
  "M12 3.4v11.4M8.1 10.9l3.9 3.9 3.9-3.9",
  "M4.3 15.2v3.3c0 1.2.9 2.1 2.1 2.1h11.2c1.2 0 2.1-.9 2.1-2.1v-3.3"
]);

export const ExternalLink = createIcon("ExternalLink", [
  "M10.3 4.7H6.5c-1.1 0-1.9.8-1.9 1.9v10.9c0 1.1.8 1.9 1.9 1.9h10.9c1.1 0 1.9-.8 1.9-1.9v-3.8",
  "M11.1 12.9 20 4M13.5 4H20v6.5"
]);

export const FileCode2 = createIcon("FileCode2", [
  documentOutline,
  documentFold,
  "M10.4 12.1 8.6 14.2l1.8 2.1M13.6 12.1l1.8 2.1-1.8 2.1"
]);

export const FilePlus2 = createIcon("FilePlus2", [
  documentOutline,
  documentFold,
  "M12 11.4v6M9 14.4h6"
]);

export const FileText = createIcon("FileText", [
  documentOutline,
  documentFold,
  "M8.4 12.3h7.2M8.4 15.6h5.4"
]);

export const FileType2 = createIcon("FileType2", [
  documentOutline,
  documentFold,
  "M9 17.4 12 11l3 6.4M10 15.3h4"
]);

export const Folder = createIcon("Folder", [
  folderOutline,
  "M3.4 9h17.2"
]);

export const FolderOpen = createIcon("FolderOpen", [
  "M3.6 16.8V6.7c0-1.2.8-2.1 2-2.1h3.9c.6 0 1.1.3 1.5.7l1.3 1.5h5.9c1.2 0 2 .8 2 2v.8",
  "M7.1 9.6h13.1c.8 0 1.3.8 1.1 1.5l-2 6.7c-.3 1-1.1 1.6-2.1 1.6H5.7c-1.1 0-1.9-1-1.6-2.1l1.4-6.4c.2-.8.8-1.3 1.6-1.3Z"
]);

export const FolderPlus = createIcon("FolderPlus", [
  folderOutline,
  "M3.4 9h17.2M12 11.3v5.7M9.15 14.15h5.7"
]);

export const Grid2X2 = createIcon("Grid2X2", [
  "M5.6 4.1h3.1c.9 0 1.4.5 1.4 1.4v3.1c0 .9-.5 1.4-1.4 1.4H5.6c-.9 0-1.4-.5-1.4-1.4V5.5c0-.9.5-1.4 1.4-1.4Z",
  "M15.3 4.1h3.1c.9 0 1.4.5 1.4 1.4v3.1c0 .9-.5 1.4-1.4 1.4h-3.1c-.9 0-1.4-.5-1.4-1.4V5.5c0-.9.5-1.4 1.4-1.4Z",
  "M5.6 14h3.1c.9 0 1.4.5 1.4 1.4v3.1c0 .9-.5 1.4-1.4 1.4H5.6c-.9 0-1.4-.5-1.4-1.4v-3.1c0-.9.5-1.4 1.4-1.4Z",
  "M15.3 14h3.1c.9 0 1.4.5 1.4 1.4v3.1c0 .9-.5 1.4-1.4 1.4h-3.1c-.9 0-1.4-.5-1.4-1.4v-3.1c0-.9.5-1.4 1.4-1.4Z"
]);

export const HardDrive = createIcon("HardDrive", [
  "M6.2 5.8h11.6l2.7 8v3.5c0 1.1-.8 1.9-1.9 1.9H5.4c-1.1 0-1.9-.8-1.9-1.9v-3.5Z",
  "M3.8 13.8h16.4M6.8 16.5h.02M10.1 16.5h.02"
]);

export const Info = createIcon("Info", [
  circleOutline,
  "M12 10.7v6M12 7.3h.02"
]);

export const Keyboard = createIcon("Keyboard", [
  "M4.9 5.5h14.2c1.2 0 2.1.9 2.1 2.1v8.8c0 1.2-.9 2.1-2.1 2.1H4.9c-1.2 0-2.1-.9-2.1-2.1V7.6c0-1.2.9-2.1 2.1-2.1Z",
  "M6.1 9h.1M10 9h.1M13.9 9h.1M17.8 9h.1M6.1 12.3h.1M10 12.3h.1M13.9 12.3h.1M17.8 12.3h.1M7.5 15.5h9"
]);

export const ListTree = createIcon("ListTree", [
  "M4.1 5.2h.02M8.5 5.2h11.4M5.2 9.7v7.2c0 1 .6 1.6 1.6 1.6h2M5.4 12h3.4M12 12h7.9M12 18.5h7.9"
]);

export const LockKeyhole = createIcon("LockKeyhole", [
  "M7.4 10.1h9.2c1.3 0 2.3 1 2.3 2.3v5.9c0 1.3-1 2.3-2.3 2.3H7.4c-1.3 0-2.3-1-2.3-2.3v-5.9c0-1.3 1-2.3 2.3-2.3Z",
  "M8 10V7.3a4 4 0 0 1 8 0V10",
  "M12.9 14.6a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0ZM12 15.5v1.7"
]);

export const Maximize2 = createIcon("Maximize2", [
  "M14.8 4.8h4.4v4.4M19.2 4.8l-5.1 5.1M9.2 19.2H4.8v-4.4M4.8 19.2l5.1-5.1"
]);

export const Minimize2 = createIcon("Minimize2", [
  "M4.5 19.5 9.5 14.5M4.7 14.5h4.8v4.8M19.5 4.5 14.5 9.5M14.5 4.7v4.8h4.8"
]);

export const Minus = createIcon("Minus", [
  "M5.1 12h13.8"
]);

export const Moon = createIcon("Moon", [
  "M20.2 14.6A8.8 8.8 0 0 1 9.4 3.8a8.5 8.5 0 1 0 10.8 10.8Z"
]);

export const MoreHorizontal = createIcon("MoreHorizontal", [
  {
    d: "M6.4 12a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0ZM13.15 12a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0ZM19.9 12a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0Z",
    fill: "currentColor",
    stroke: "none"
  }
]);

export const NotebookPen = createIcon("NotebookPen", [
  "M19.3 7.9V5.7c0-1.2-.9-2.1-2.1-2.1H6.7c-1.2 0-2.1.9-2.1 2.1v12.6c0 1.2.9 2.1 2.1 2.1h3.5M8.1 3.9v16.2M3.1 8h3M3.1 15.8h3",
  "M13.1 16.9l5.7-5.7c.5-.5 1.3-.5 1.8 0l.2.2c.5.5.5 1.3 0 1.8l-5.7 5.7-3.1 1Z",
  "M17.7 12.3l2 2"
]);

export const PanelLeft = createIcon("PanelLeft", [
  panelOutline,
  "M8.2 4.9v14.2"
]);

export const PanelLeftClose = createIcon("PanelLeftClose", [
  panelOutline,
  "M8.2 4.9v14.2M15.7 9.1 12.8 12l2.9 2.9"
]);

export const PanelRight = createIcon("PanelRight", [
  panelOutline,
  "M15.8 4.9v14.2"
]);

export const Pencil = createIcon("Pencil", [
  "M5.6 15.3 16.1 4.8c.9-.9 2.1-.9 3 0l.1.1c.9.9.9 2.1 0 3L8.7 18.4l-4.4 1.3Z",
  "M14.8 6.1l3.1 3.1M5.6 15.3l3.1 3.1"
]);

export const PenLine = createIcon("PenLine", [
  "M12.4 4.5H6.2c-1.2 0-2.1.9-2.1 2.1v11.1c0 1.2.9 2.1 2.1 2.1h11.1c1.2 0 2.1-.9 2.1-2.1v-6.2",
  "M10.5 11.5 18.2 3.8c.6-.6 1.4-.6 2 0l.1.1c.6.6.6 1.4 0 2l-7.7 7.7-3.1.9Z",
  "M17 5l2 2"
]);

export const Plus = createIcon("Plus", [
  "M12 4.9v14.2M4.9 12h14.2"
]);

export const Printer = createIcon("Printer", [
  "M6.5 8V3.6h11V8",
  "M6.5 17.5H5.2c-1.1 0-1.9-.8-1.9-1.9v-5.4c0-1.1.8-1.9 1.9-1.9h13.6c1.1 0 1.9.8 1.9 1.9v5.4c0 1.1-.8 1.9-1.9 1.9h-1.3",
  "M6.5 13.6h11v7h-11ZM17.2 11.1h.02"
]);

export const Redo2 = createIcon("Redo2", [
  "M15.2 5.4 19.8 10l-4.6 4.6M19.5 10h-9.4c-3.2 0-5.7 2.5-5.7 5.6 0 1 .3 2 .8 2.8"
]);

export const RefreshCw = createIcon("RefreshCw", [
  "M19.4 9.4A7.7 7.7 0 0 0 6.6 6.3L4.1 8.8M4.1 4.5v4.3h4.3",
  "M4.6 14.6a7.7 7.7 0 0 0 12.8 3.1l2.5-2.5M19.9 19.5v-4.3h-4.3"
]);

export const Replace = createIcon("Replace", [
  "M5.1 7.1h12.4c1 0 1.8.8 1.8 1.8v1.5M8.3 3.9 5.1 7.1l3.2 3.2",
  "M18.9 16.9H6.5c-1 0-1.8-.8-1.8-1.8v-1.5M15.7 13.7l3.2 3.2-3.2 3.2"
]);

export const Save = createIcon("Save", [
  "M7.6 7.1H6.2c-1.2 0-2.1.9-2.1 2.1v9.1c0 1.2.9 2.1 2.1 2.1h11.6c1.2 0 2.1-.9 2.1-2.1V9.2c0-1.2-.9-2.1-2.1-2.1h-1.4",
  "M12 3.2v11.6M8.4 11.2l3.6 3.6 3.6-3.6"
]);

export const Search = createIcon("Search", [
  "M16.8 10.4a6.4 6.4 0 1 1-12.8 0 6.4 6.4 0 0 1 12.8 0ZM15.2 15.2l5.1 5.1"
]);

export const Settings2 = createIcon("Settings2", [
  "M10.5 3h3l.5 2.2 1.5.6 1.9-1.2 2 2-1.2 1.9.6 1.5 2.2.5v3l-2.2.5-.6 1.5 1.2 1.9-2 2-1.9-1.2-1.5.6-.5 2.2h-3l-.5-2.2-1.5-.6-1.9 1.2-2-2 1.2-1.9-.6-1.5-2.2-.5v-3l2.2-.5.6-1.5-1.2-1.9 2-2 1.9 1.2 1.5-.6Z",
  "M15.2 12a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0Z"
]);

export const Share = createIcon("Share", [
  "M8.2 8.6H6.4c-1.2 0-2.1.9-2.1 2.1V18c0 1.2.9 2.1 2.1 2.1h11.2c1.2 0 2.1-.9 2.1-2.1v-7.3c0-1.2-.9-2.1-2.1-2.1h-1.8",
  "M12 13.4V3.2M8.3 6.9 12 3.2l3.7 3.7"
]);

export const ShieldCheck = createIcon("ShieldCheck", [
  "M12 3.2c2.4 1.7 5 2.7 7.7 3.2v5.1c0 4.1-2.8 7.3-7.7 9.3-4.9-2-7.7-5.2-7.7-9.3V6.4c2.7-.5 5.3-1.5 7.7-3.2Z",
  "M8.6 11.8 11 14.3l4.6-4.7"
]);

export const Sparkles = createIcon("Sparkles", [
  "M14.3 3.1c.7 4.6 2.1 6 6.6 6.7-4.5.7-5.9 2.1-6.6 6.6-.7-4.5-2.1-5.9-6.6-6.6 4.5-.7 5.9-2.1 6.6-6.7Z",
  "M5.7 13.9c.4 2.3 1.1 3 3.4 3.4-2.3.4-3 1.1-3.4 3.4-.4-2.3-1.1-3-3.4-3.4 2.3-.4 3-1.1 3.4-3.4ZM4.2 3.5v3M2.7 5h3"
]);

export const Sun = createIcon("Sun", [
  "M15.8 12a3.8 3.8 0 1 1-7.6 0 3.8 3.8 0 0 1 7.6 0Z",
  "M12 2.9V5M12 19v2.1M2.9 12H5M19 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5"
]);

export const Trash2 = createIcon("Trash2", [
  "M4.6 6.6h14.8M9.1 6.6V4.8c0-.9.6-1.5 1.5-1.5h2.8c.9 0 1.5.6 1.5 1.5v1.8",
  "M6.3 6.8l.8 12c.1 1 .8 1.7 1.8 1.7h6.2c1 0 1.7-.7 1.8-1.7l.8-12M10 10.1l.3 6.7M14 10.1l-.3 6.7"
]);

export const Undo2 = createIcon("Undo2", [
  "M8.8 5.4 4.2 10l4.6 4.6M4.5 10h9.4c3.2 0 5.7 2.5 5.7 5.6 0 1-.3 2-.8 2.8"
]);

export const X = createIcon("X", [
  "M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8"
]);
