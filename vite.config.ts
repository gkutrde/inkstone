import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      "marked",
      "dompurify",
      "katex",
      "@milkdown/crepe/builder",
      "@milkdown/crepe/feature/block-edit",
      "@milkdown/crepe/feature/code-mirror",
      "@milkdown/crepe/feature/cursor",
      "@milkdown/crepe/feature/image-block",
      "@milkdown/crepe/feature/link-tooltip",
      "@milkdown/crepe/feature/list-item",
      "@milkdown/crepe/feature/placeholder",
      "@milkdown/crepe/feature/table",
      "@milkdown/crepe/feature/toolbar"
    ]
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] }
  },
  envPrefix: ["VITE_", "TAURI_"]
});
