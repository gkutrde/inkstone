import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import {
  installWindowProbe,
  metricsEnabled,
  observeLongTasks,
  recordCommit
} from "./lib/editorMetrics";

try {
  const stored = JSON.parse(localStorage.getItem("inkstone.settings.v1") ?? "null") as { theme?: string } | null;
  if (stored?.theme === "paper" || stored?.theme === "sepia" || stored?.theme === "night") {
    document.documentElement.dataset.theme = stored.theme;
  }
} catch {
  // Invalid local settings fall back to the paper theme without blocking startup.
}

if ("__TAURI_INTERNALS__" in window && !("__PERF_FS" in window)) {
  document.documentElement.dataset.desktopFrame = "true";
}

installWindowProbe();
observeLongTasks();

const tree = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  metricsEnabled ? (
    <React.Profiler id="inkstone" onRender={recordCommit}>
      {tree}
    </React.Profiler>
  ) : (
    tree
  )
);
