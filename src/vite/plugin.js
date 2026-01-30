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

// Default ports (fallback if registry not found)
const DEFAULT_WS_PORT = 9899;

/**
 * Check if a process is still running
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the instance registry, returning live instances
 */
function readRegistry(projectRoot) {
  const registryFile = join(projectRoot, ".notebookkit-debug", "registry.json");
  try {
    if (existsSync(registryFile)) {
      const registry = JSON.parse(readFileSync(registryFile, "utf-8"));

      // Filter to only live instances
      const liveInstances = {};
      for (const [id, info] of Object.entries(registry.instances || {})) {
        if (isProcessAlive(info.pid)) {
          liveInstances[id] = info;
        }
      }

      return { instances: liveInstances };
    }
  } catch (err) {
    console.warn("[debug-notebook] Could not read registry:", err.message);
  }
  return { instances: {} };
}

/**
 * Find the best instance for a given notebook path
 */
function findInstanceForNotebook(registry, notebookPath) {
  // First, try to find an instance that has claimed this notebook
  for (const [id, info] of Object.entries(registry.instances)) {
    if (info.notebooks && info.notebooks.includes(notebookPath)) {
      return info;
    }
  }

  // If not found, return any available instance (prefer ones with fewer notebooks)
  const instances = Object.values(registry.instances);
  if (instances.length === 0) return null;

  // Sort by number of claimed notebooks (ascending)
  instances.sort((a, b) => (a.notebooks?.length || 0) - (b.notebooks?.length || 0));
  return instances[0];
}

/**
 * Read the port configuration (legacy support + new registry)
 */
function readPortConfig(projectRoot) {
  // Try the new registry first
  const registry = readRegistry(projectRoot);
  const instances = Object.values(registry.instances);

  if (instances.length > 0) {
    // Return the first instance's WS port as the default
    // The actual routing happens in the WebSocket upgrade handler
    return { ws: instances[0].ws, registry: true, instanceCount: instances.length };
  }

  // Fall back to legacy port file
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
      server.httpServer?.on('upgrade', (req, socket, head) => {
        // Only proxy requests to our debug paths
        // Supports both /__debug_ws and /__debug_ws/<notebook-path>
        if (!req.url?.startsWith('/__debug_ws')) return;

        // Extract notebook path from URL if present
        // Format: /__debug_ws or /__debug_ws/<encoded-notebook-path>
        let notebookPath = null;
        if (req.url.length > '/__debug_ws'.length) {
          const pathPart = req.url.slice('/__debug_ws/'.length);
          // Handle query params if any
          const queryIndex = pathPart.indexOf('?');
          const encodedPath = queryIndex >= 0 ? pathPart.slice(0, queryIndex) : pathPart;
          notebookPath = decodeURIComponent(encodedPath);
        }

        // Read registry and find the appropriate instance
        const registry = readRegistry(projectRoot);
        let targetInstance = null;

        if (notebookPath) {
          targetInstance = findInstanceForNotebook(registry, notebookPath);
          if (targetInstance) {
            console.log(`[debug-notebook] Routing ${notebookPath} to instance on port ${targetInstance.ws}`);
          }
        }

        // Fall back to any available instance
        if (!targetInstance) {
          const instances = Object.values(registry.instances);
          if (instances.length > 0) {
            targetInstance = instances[0];
          }
        }

        // If still no instance, try legacy port config
        if (!targetInstance) {
          const legacyConfig = readPortConfig(projectRoot);
          targetInstance = { ws: legacyConfig.ws };
        }

        const wsPort = targetInstance.ws || DEFAULT_WS_PORT;

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
