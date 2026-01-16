/**
 * Debug client entry point
 * This file is bundled by esbuild and injected into the page by the Vite plugin
 */

import { DebugClient } from "./client.js";

(function () {
  // Get port from injected config, fallback to default
  const config = window.__NOTEBOOKKIT_DEBUG_CONFIG__ || { ws: 9899 };

  let client = null;

  function initDebugClient() {
    // Clean up any existing client (e.g., from bfcache restoration)
    if (client) {
      try {
        if (client.ws) {
          client.ws.onclose = null;
          client.ws.close();
        }
      } catch (e) {}
    }

    client = new DebugClient(config);
    client.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDebugClient);
  } else {
    initDebugClient();
  }

  // Handle bfcache restoration (mobile browsers cache pages and restore them)
  // When restored from bfcache, the WebSocket is dead but JS state persists
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      initDebugClient();
    }
  });
})();
