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
