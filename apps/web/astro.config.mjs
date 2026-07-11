import { defineConfig, envField } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

/** Dev-only: pretty /r/:code → /room shell (prod uses host rewrite). */
function roomPrettyUrlDev() {
  return {
    name: "vidsync-room-pretty-url",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/r\/[A-Za-z0-9]+\/?(\?.*)?$/.test(req.url)) {
          req.url = "/room";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  output: "static",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss(), roomPrettyUrlDev()],
  },
  env: {
    schema: {
      PUBLIC_API_URL: envField.string({
        context: "client",
        access: "public",
        default: "http://localhost:8787",
      }),
    },
  },
});
