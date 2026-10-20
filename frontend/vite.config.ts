import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Servido pelo próprio backend em /painel/ — base fixa, sem CORS.
export default defineConfig({
  base: "/painel/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/": "http://127.0.0.1:8000" } },
});