import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app lives at /app on desk's own server, beside the old pages, until it takes over (sub-issue 5).
// StyleX goes before React's plugin, to keep Fast Refresh (stylexjs.com/docs/learn/installation/vite/vite-react).
export default defineConfig({
  base: "/app/",
  plugins: [stylex.vite({ useCSSLayers: true }), react()],
  server: {
    // While building, Vite serves the app with hot reload and hands desk's own calls to the desk on 8790.
    proxy: {
      "/api": { target: "http://127.0.0.1:8790", ws: true },
      "/static": "http://127.0.0.1:8790",
    },
  },
});
