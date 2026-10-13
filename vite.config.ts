import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { minifySync } from "rolldown/utils";
import { defineConfig, type Plugin } from "vite";

/**
 * public/widget.js stays readable in the repo; the copy we serve is minified (it runs on
 * every customer page, budget: 6 KB gzipped, D-38). Keeps the license header.
 */
function minifyLoader(): Plugin {
  return {
    name: "jun:minify-loader",
    apply: "build",
    writeBundle(options) {
      // The AI-21 page-actions chunk (widget-actions.js) is minified the same way.
      for (const name of ["widget.js", "widget-actions.js"]) {
        const file = join(options.dir ?? "", name);
        if (!existsSync(file)) continue;
        const source = readFileSync(file, "utf8");
        if (!source.startsWith("/*!")) continue; // already minified
        const result = minifySync(name, source, { compress: true, mangle: true });
        if (result.errors.length) throw new Error(`${name} minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
        writeFileSync(file, `/*! Jun Desk ${name === "widget.js" ? "widget loader" : "page actions"} | MIT License | source: public/${name} */\n${result.code}`);
      }
    },
  };
}

/**
 * The widget frame loads on customers' pages, so it's its own build on Preact (preact/compat)
 * instead of React: about 30 KB of JS gzipped instead of about 92 KB (D-41). The dashboard stays
 * on React. `vite dev` serves both pages from one module graph, so the frame runs on React there;
 * check widget changes on a built version too (scripts/deploy.ts, or `wrangler versions upload`).
 */
const PREACT: [RegExp, string][] = [
  [/^react-dom\/client$/, "preact/compat/client"],
  [/^react-dom$/, "preact/compat"],
  [/^react\/jsx-(dev-)?runtime$/, "preact/jsx-runtime"],
  [/^react$/, "preact/compat"],
];
function preactWidget(): Plugin {
  return {
    name: "jun:preact-widget",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "widget",
    resolveId(source, importer, options) {
      const to = PREACT.find(([from]) => from.test(source))?.[1];
      return to ? this.resolve(to, importer, { ...options, skipSelf: true }) : null;
    },
  };
}
/** Builds the widget environment after the Cloudflare plugin's own build (client + Worker). */
function buildWidget(): Plugin {
  return {
    name: "jun:build-widget",
    apply: "build",
    buildApp: {
      // After the config's buildApp (the Cloudflare plugin's), whose client build empties the folder.
      order: "post",
      async handler(builder) {
        const widget = builder.environments.widget;
        if (widget && !widget.isBuilt) await builder.build(widget);
      },
    },
  };
}

// Builds the dashboard (index.html), the widget frame (widget.html) and the Worker
// (worker/) together; `vite dev` runs them in the Workers runtime with local D1,
// R2 and Durable Objects. public/ (widget.js loader, demo.html) is copied; widget.js gets minified.
export default defineConfig({
  // JUN_STATE_DIR gives a separate local database (used by the e2e tests so they don't
  // touch your own local desk). Pair with `wrangler ... --persist-to` on the same path.
  // Tailwind (shadcn/ui) only processes CSS that imports it: web/desk.css, the dashboard's sheet.
  // The widget frame keeps its own plain CSS (web/styles.css + web/widget/widget.css).
  plugins: [preactWidget(), react(), tailwindcss(), minifyLoader(), buildWidget(), cloudflare(process.env.JUN_STATE_DIR ? { persistState: { path: process.env.JUN_STATE_DIR } } : {})],
  // Listen on 127.0.0.1: dev-only "Sign in with ChatGPT" must return to a 127.0.0.1
  // loopback URL (OpenAI forbids substituting localhost), and on Windows Vite would
  // otherwise bind IPv6 only. http://localhost:5173 still works in browsers.
  server: { host: "127.0.0.1" },
  // shadcn/ui imports: "@/components/ui/…", "@/lib/utils.ts".
  resolve: { alias: { "@": resolve(import.meta.dirname, "web") } },
  // Only the browser build has two pages; the Worker build keeps its own entry.
  environments: {
    client: {
      // The Dashboard's chart is lazy-loaded, so dev would only discover these on first open
      // and answer "504 Outdated Optimize Dep" until a reload: pre-bundle them at startup.
      optimizeDeps: { include: ["motion/react", "d3-scale", "d3-shape"] },
      build: { rollupOptions: { input: { main: "index.html" } } },
    },
    // The widget frame (see preactWidget): built into the same folder, after the client build.
    widget: {
      consumer: "client",
      build: { outDir: "dist/client", emptyOutDir: false, copyPublicDir: false, rollupOptions: { input: { widget: "widget.html" } } },
    },
  },
});
