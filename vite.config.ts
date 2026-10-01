import path from "node:path";
import { vitePluginEditframe } from "@editframe/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Rendered media / cache writes must not trigger HMR reloads mid-render.
    watch: { ignored: ["**/src/assets/**", "**/output/**", "**/work/**", "**/.cache/**"] },
  },
  plugins: [
    react(),
    tailwindcss(),
    vitePluginEditframe({
      root: path.join(import.meta.dirname, "src"),
      cacheRoot: path.join(import.meta.dirname, ".cache"),
    }),
  ],
});
