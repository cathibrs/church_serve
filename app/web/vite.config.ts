import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  // O endereço do login vem de NEON_AUTH_BASE_URL (a mesma variável que a API usa e que
  // "neon env pull" grava em .env.local). VITE_NEON_AUTH_URL só é preciso para trocar o endereço.
  const env = { ...loadEnv(mode, import.meta.dirname, ""), ...process.env };
  const authUrl = env.VITE_NEON_AUTH_URL || env.NEON_AUTH_BASE_URL || "";
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    define: { "import.meta.env.VITE_NEON_AUTH_URL": JSON.stringify(authUrl) },
    build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1100 },
    // "npm run dev" usa o netlify dev, que serve este Vite e as funções de /api juntos.
    test: { include: ["server/**/*.test.ts"] },
  };
});
