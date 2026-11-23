import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  publicDir: isSsrBuild ? false : "public",
  build: {
    outDir: isSsrBuild ? "dist/local-server" : "dist/local-client",
    emptyOutDir: true,
    ...(isSsrBuild ? { ssr: "local/server.ts", target: "node22" } : {}),
  },
}));
