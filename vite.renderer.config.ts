import path from "node:path";

import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: path.resolve(__dirname, "renderer"),
  base: "./",
  plugins: [preact()],
  build: {
    outDir: path.resolve(__dirname, "dist", "renderer"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "renderer", "index.html"),
        overlay: path.resolve(__dirname, "renderer", "overlay.html")
      }
    }
  }
});
