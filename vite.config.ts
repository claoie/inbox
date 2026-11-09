import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Emits `asset-manifest.json`, every hashed file of the build, so the service
 * worker can cache a whole build before a later deploy deletes it from disk.
 */
const assetManifest = (): Plugin => ({
  name: "asset-manifest",
  generateBundle(_, bundle) {
    const assets = Object.keys(bundle)
      .filter((fileName) => fileName.startsWith("assets/"))
      .map((fileName) => `/${fileName}`);
    this.emitFile({
      type: "asset",
      fileName: "asset-manifest.json",
      source: JSON.stringify(assets),
    });
  },
});

export default defineConfig({
  plugins: [react(), assetManifest()],
  resolve: {
    alias: {
      client: path.resolve(__dirname, "./src/client"),
      server: path.resolve(__dirname, "./src/server"),
      common: path.resolve(__dirname, "./src/common"),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
  },
  root: ".",
  publicDir: "public",
  build: {
    outDir: "build/client",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3004",
        changeOrigin: true,
      },
    },
  },
});
