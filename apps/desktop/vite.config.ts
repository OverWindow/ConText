import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  base: "./",
  resolve: {
    alias: { "@context/ui": fileURLToPath(new URL("../../frontend/shared/ui/document-paper.tsx", import.meta.url)) },
    dedupe: ["react", "react-dom", "react-icons", "@xyflow/react"],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
