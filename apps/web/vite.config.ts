import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite runs this file in Node; the app's own types leave Node's out, so only the one global used here is declared.
declare const process: { env: Record<string, string | undefined> };

// StyleX goes before React's plugin, to keep Fast Refresh (stylexjs.com/docs/learn/installation/vite/vite-react).
export default defineConfig({
  plugins: [stylex.vite({ useCSSLayers: true }), react()],
  server: {
    // While building, Vite serves the app with hot reload and hands every call of desk's to the desk on DESK
    // (default 8790), except a page itself, which is the app: the usual way to put an API behind a dev server.
    proxy: {
      "^/(?!@|src/|node_modules/|fonts/|favicon).*": {
        target: process.env.DESK ?? "http://127.0.0.1:8790",
        ws: true,
        bypass: (req) => (req.headers.accept?.includes("text/html") ? "/index.html" : undefined),
      },
    },
  },
});
