/**
 * Exposes the Observable runtime on window for the debug client.
 * This file is served by Vite during development only.
 */
import { main } from "@observablehq/notebook-kit/runtime";
window.__observableRuntime = main;

// Bridge Vite HMR errors to the debug client.
// import.meta.hot is only available in files processed by Vite's pipeline,
// which is why this hook lives here rather than in the bundled debug-client.js.
if (import.meta.hot) {
  window.__viteErrors = window.__viteErrors || [];

  import.meta.hot.on("vite:error", (payload) => {
    const err = payload?.err || payload;
    const errorInfo = {
      message: err?.message || String(err),
      stack: err?.stack || null,
      frame: err?.frame || null,   // Vite's code frame (snippet with caret)
      loc: err?.loc || null,       // { file, line, column }
      plugin: err?.plugin || null,
      id: err?.id || null,
    };

    window.__viteErrors.push(errorInfo);

    // Dispatch a DOM event so the debug client (bundled IIFE) can hear it.
    window.dispatchEvent(new CustomEvent("vite:error", { detail: errorInfo }));
  });
}
