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
import { connect as netConnect } from "net";

// File paths for client scripts
const CLIENT_FILES = {
  runtimeExpose: new URL("./client/runtime-expose.js", import.meta.url),
  earlyConsolePatch: new URL("./client/early-console-patch.js", import.meta.url),
  debugClient: new URL("../../dist/debug-client.js", import.meta.url),
};

// Read client file - in dev mode, reads fresh each time for easier development
function readClientFile(url) {
  return readFileSync(url, "utf-8");
}

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
  let serverHost = null;

  return {
    name: "debug-notebook",
    enforce: "pre",

    configResolved(config) {
      isDevMode = config.command === "serve";
      projectRoot = config.root || process.cwd();
      // Capture vite's host configuration
      // If host is true or a string (not localhost/127.0.0.1), we'll use window.location.hostname
      const host = config.server?.host;
      if (host === true || (typeof host === 'string' && host !== 'localhost' && host !== '127.0.0.1')) {
        serverHost = 'auto'; // Signal to client to use window.location.hostname
      }
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
        return readClientFile(CLIENT_FILES.runtimeExpose);
      }
    },

    // Serve the virtual module via HTTP and proxy WebSocket connections
    configureServer(server) {
      // Proxy WebSocket connections to the MCP server
      const portConfig = readPortConfig(projectRoot);
      const wsPort = portConfig.ws || DEFAULT_WS_PORT;

      server.httpServer?.on('upgrade', (req, socket, head) => {
        // Only proxy requests to our debug path
        if (req.url === '/__debug_ws') {
          const targetSocket = netConnect(wsPort, 'localhost', () => {
            // Forward the upgrade request
            targetSocket.write(
              `GET / HTTP/1.1\r\n` +
              `Host: localhost:${wsPort}\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n` +
              `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` +
              `\r\n`
            );
            // Pipe data between client and target
            socket.pipe(targetSocket);
            targetSocket.pipe(socket);
          });

          targetSocket.on('error', (err) => {
            console.error('[debug-notebook] WebSocket proxy error:', err.message);
            socket.destroy();
          });

          socket.on('error', () => targetSocket.destroy());
        }
      });

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
      // Add host configuration if vite is running with --host
      if (serverHost) {
        portConfig.host = serverHost;
      }
      const configScript = `window.__NOTEBOOKKIT_DEBUG_CONFIG__ = ${JSON.stringify(portConfig)};`;

      // Read client files fresh each time for easier development
      const earlyConsolePatch = readClientFile(CLIENT_FILES.earlyConsolePatch);
      const debugClientCode = readClientFile(CLIENT_FILES.debugClient);

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
