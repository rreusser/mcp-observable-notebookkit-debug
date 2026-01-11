/**
 * Vite Plugin for Observable Notebook Debugging
 *
 * Injects the debug client and early console capture into notebooks
 * during development. This plugin is designed to work with the
 * debug-notebook MCP server.
 *
 * Usage in vite.config.js:
 *   import { debugNotebook } from './.claude/mcp-servers/debug-notebook/vite-plugin.js';
 *   export default defineConfig({
 *     plugins: [debugNotebook(), ...otherPlugins]
 *   });
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const runtimeExposeCode = readFileSync(
  new URL("./client/runtime-expose.js", import.meta.url),
  "utf-8"
);
const earlyConsolePatch = readFileSync(
  new URL("./client/early-console-patch.js", import.meta.url),
  "utf-8"
);
const debugClientCode = readFileSync(
  new URL("./client/debug-client.js", import.meta.url),
  "utf-8"
);

// Virtual module ID for runtime exposure (Vite will transform the imports)
const VIRTUAL_RUNTIME_ID = "virtual:debug-notebook-runtime";
const RESOLVED_VIRTUAL_RUNTIME_ID = "\0" + VIRTUAL_RUNTIME_ID;

// Default ports (fallback if port file not found)
const DEFAULT_WS_PORT = 9899;

/**
 * Read the port configuration from .notebookkit-debug/port
 */
function readPortConfig(projectRoot) {
  const portFile = join(projectRoot, ".notebookkit-debug", "port");
  try {
    if (existsSync(portFile)) {
      const config = JSON.parse(readFileSync(portFile, "utf-8"));
      return config;
    }
  } catch (err) {
    console.warn("[debug-notebook] Could not read port file:", err.message);
  }
  return { ws: DEFAULT_WS_PORT };
}

/**
 * Vite plugin for notebook debugging
 * Only activates in development mode
 */
export function debugNotebook() {
  let isDevMode = false;
  let projectRoot = process.cwd();

  return {
    name: "debug-notebook",
    enforce: "pre",

    configResolved(config) {
      isDevMode = config.command === "serve";
      projectRoot = config.root || process.cwd();
    },

    // Virtual module resolution for runtime exposure
    resolveId(id) {
      if (id === VIRTUAL_RUNTIME_ID) {
        return RESOLVED_VIRTUAL_RUNTIME_ID;
      }
    },

    // Virtual module content
    load(id) {
      if (id === RESOLVED_VIRTUAL_RUNTIME_ID) {
        return runtimeExposeCode;
      }
    },

    // Serve the virtual module via HTTP
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === "/@debug-notebook-runtime.js") {
          try {
            // Request the virtual module through Vite's transform pipeline
            const result = await server.transformRequest(VIRTUAL_RUNTIME_ID);
            if (result) {
              res.setHeader("Content-Type", "application/javascript");
              res.end(result.code);
              return;
            }
          } catch (e) {
            console.error(
              "[debug-notebook] Failed to transform runtime module:",
              e
            );
          }
        }
        next();
      });
    },

    transformIndexHtml(html, ctx) {
      // Only inject in dev mode (serve command)
      if (!isDevMode) {
        return html;
      }

      // Read port config fresh each time (in case MCP server restarted)
      const portConfig = readPortConfig(projectRoot);
      const configScript = `window.__NOTEBOOKKIT_DEBUG_CONFIG__ = ${JSON.stringify(portConfig)};`;

      return [
        // Early console patch - must run before anything else
        {
          tag: "script",
          children: earlyConsolePatch,
          injectTo: "head-prepend",
        },
        // Port configuration - inject before debug client
        {
          tag: "script",
          children: configScript,
          injectTo: "head-prepend",
        },
        // Runtime exposure - served via middleware with Vite transform
        {
          tag: "script",
          attrs: { type: "module", src: "/@debug-notebook-runtime.js" },
          injectTo: "body",
        },
        // Debug client - runs after DOM is ready
        {
          tag: "script",
          attrs: { type: "module" },
          children: debugClientCode,
          injectTo: "body",
        },
      ];
    },
  };
}

export default debugNotebook;
