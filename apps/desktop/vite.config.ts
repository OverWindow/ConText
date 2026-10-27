import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  resolve: {
    dedupe: ["react", "react-dom", "react-icons", "@xyflow/react"],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
