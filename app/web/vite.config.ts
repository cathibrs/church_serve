import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Nenhuma variável de ambiente entra no site durante o build: o endereço do login
// é pedido à API (/api/config) quando a página abre.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1100 },
  // "npm run dev" usa o netlify dev, que serve este Vite e as funções de /api juntos.
  test: { include: ["server/**/*.test.ts"] },
});
