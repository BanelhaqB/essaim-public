import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests de la logique serveur sans le runtime Workers : `cloudflare:workers` devient un env que les tests remplissent.
export default defineConfig({
  resolve: {
    alias: {
      "~": path.join(import.meta.dirname, "app"),
      "cloudflare:workers": path.join(import.meta.dirname, "test/cloudflare-workers.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
