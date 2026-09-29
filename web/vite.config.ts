import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // import.meta.dirname rather than new URL(...).pathname: the latter is
  // URL-encoded, so a checkout under a path containing a space or a non-ASCII
  // name resolves to %20 and the alias silently points nowhere.
  resolve: { alias: { "@": import.meta.dirname + "/src" } },
  // The release the page belongs to, from the one version source; the Hub that
  // embeds this build is built from the same tree.
  define: { __ROMI_VERSION__: JSON.stringify(readFileSync(import.meta.dirname + "/../VERSION", "utf8").trim()) },
  build: { chunkSizeWarningLimit: 900 },
  // The other app is served by the local hub; only this app uses Vite HMR.
  server: { proxy: {
    "/api": { target: "http://127.0.0.1:9911", ws: true },
    "/admin": { target: "http://127.0.0.1:9911", ws: true },
  } },
})
