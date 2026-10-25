import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5176, proxy: { "/api": "http://localhost:8010", "/run": "http://localhost:8010" } },
});
