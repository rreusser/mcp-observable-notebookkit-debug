/**
 * Debug client entry point
 * This file is bundled by esbuild and injected into the page by the Vite plugin
 */

import { DebugClient } from "./client.js";

(function () {
  // Only run on localhost
  if (
    window.location.hostname !== "localhost" &&
    !window.location.hostname.match(/127\.0\.0\.1/)
  ) {
    return;
  }

  // Get port from injected config, fallback to default
  const config = window.__NOTEBOOKKIT_DEBUG_CONFIG__ || { ws: 9899 };
  console.log("[DebugClient] Config:", window.__NOTEBOOKKIT_DEBUG_CONFIG__, "-> Using port", config.ws);

  function initDebugClient() {
    const client = new DebugClient(config);
    client.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDebugClient);
  } else {
    initDebugClient();
  }
})();
