/**
 * Main DebugClient class - WebSocket connection and message routing
 */

import { getRuntimeModule } from "./utils/runtime.js";
import { patchConsole } from "./utils/console.js";
import { setupErrorWatching, handleGetErrorsRequest } from "./handlers/errors.js";
import { handleGetValueRequest, handleGetValuesRequest, handleListValuesRequest, handleGetValueMetadataRequest } from "./handlers/values.js";
import { handleSetInputRequest } from "./handlers/inputs.js";
import { handleGetElementContentRequest } from "./handlers/elements.js";
import { handleGetDependencyGraphRequest } from "./handlers/graph.js";
import { handleBrowserEvalRequest } from "./handlers/eval.js";
import { handleRuntimeEvalRequest } from "./handlers/variables.js";
import { handleMouseClickRequest, handleMouseDragRequest, handleMouseWheelRequest, handleMouseHoverRequest } from "./handlers/mouse.js";
import { handleSendKeysRequest } from "./handlers/keyboard.js";
import { logEvent, logResponse, initEventLog, setConnectionStatus, getEnabled, setEnabledChangeHandler } from "./ui/event-log.js";

const RECONNECT_INTERVAL = 2000;
const SESSION_TIMEOUT = 5000;
const REFRESH_SESSION_KEY = "__debug_refresh_session";

export class DebugClient {
  constructor(config) {
    this.config = config;
    this.ws = null;

    const pendingSession = sessionStorage.getItem(REFRESH_SESSION_KEY);
    if (pendingSession) {
      this.sessionId = pendingSession;
      sessionStorage.removeItem(REFRESH_SESSION_KEY);
    } else {
      this.sessionId = "session-" + Date.now();
    }

    this.connected = false;
    this.connecting = false;
    this.connectAttempts = 0;
    this.messageQueue = [];
    this.originalConsole = {};
    this.errorWatching = null;
    this.sessionStartTime = Date.now();
    this.sessionEnded = false;
    // Track injected ephemeral variables for cleanup
    this.injectedVariables = new Map();
  }

  init() {
    // Close WebSocket on page unload to prevent stale connections
    window.addEventListener('beforeunload', () => {
      if (this.ws) {
        this.ws.onclose = null;  // Prevent reconnect attempt
        this.ws.close();
      }
    });

    // Show the connection indicator immediately (dim/disconnected state)
    initEventLog();
    setConnectionStatus(false);

    // Wire the on/off switch in the event-log header to connect/disconnect.
    setEnabledChangeHandler((isEnabled) => {
      if (isEnabled) {
        this.connectAttempts = 0;
        this.connect();
      } else {
        this.disconnect();
      }
    });

    if (getEnabled()) {
      this.connect();
    }
    this.originalConsole = patchConsole(this.send.bind(this));
    this.errorWatching = setupErrorWatching(this.send.bind(this));

    setTimeout(() => {
      if (!this.sessionEnded) {
        this.endSession();
      }
    }, SESSION_TIMEOUT);

    window.__debugClient = this;

    this.setupViteErrorBridge();
    this.signalReady();
  }

  /**
   * Forward Vite build/parse errors (e.g. syntax errors in notebook cells) to MCP.
   *
   * Two detection mechanisms:
   *  1. Custom DOM event "vite:error" dispatched by runtime-expose.js (which has
   *     access to import.meta.hot and therefore Vite's HMR error events).
   *  2. MutationObserver watching for <vite-error-overlay> being added to the DOM
   *     as a fallback in case the HMR bridge fires before the debug client connects.
   */
  setupViteErrorBridge() {
    const sendViteError = (errorInfo) => {
      this.send({
        type: "vite_error",
        data: errorInfo,
      });
      // End the session so MCP doesn't wait for the runtime (which won't start).
      this.endSession();
    };

    // 1. Listen for errors forwarded from runtime-expose.js via import.meta.hot.
    window.addEventListener("vite:error", (event) => {
      sendViteError(event.detail);
    });

    // Drain any errors that arrived before this client initialized.
    if (Array.isArray(window.__viteErrors) && window.__viteErrors.length > 0) {
      for (const err of window.__viteErrors) {
        sendViteError(err);
      }
    }

    // On Vite's error replacement page (parse errors that prevent the page from
    // loading normally), plugin.js extracts the error from the HTML server-side
    // and injects it synchronously as window.__viteErrorPayload before any scripts run.
    if (window.__viteErrorPayload) {
      const err = window.__viteErrorPayload;
      sendViteError({
        message: err?.message || String(err),
        stack: err?.stack || null,
        frame: err?.frame || null,
        loc: err?.loc || null,
        plugin: err?.plugin || null,
        id: err?.id || null,
        source: 'vite-error-page',
      });
    }

    // 2. MutationObserver fallback: scrape the error overlay if it appears.
    //    This handles the case where the HMR connection is not available.
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.tagName === "VITE-ERROR-OVERLAY") {
            // Extract the error message from the overlay's shadow DOM.
            const shadowRoot = node.shadowRoot;
            const messageEl = shadowRoot?.querySelector(".message-body");
            const fileEl = shadowRoot?.querySelector(".file");
            const frameEl = shadowRoot?.querySelector(".frame");

            const message = messageEl?.textContent?.trim() || "Vite build error";
            const file = fileEl?.textContent?.trim() || null;
            const frame = frameEl?.textContent?.trim() || null;

            sendViteError({ message, file, frame, source: "vite-error-overlay" });

            // Stop observing once we've captured the error.
            observer.disconnect();
            return;
          }
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  signalReady() {
    const checkReady = () => {
      const runtime = getRuntimeModule();
      if (runtime) {
        this.endSession();
        return true;
      }
      return false;
    };

    if (checkReady()) return;

    let attempts = 0;
    const maxAttempts = 50;
    const interval = setInterval(() => {
      attempts++;
      if (checkReady() || attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 100);
  }

  /**
   * Get the notebook path identifier from the current URL
   */
  getNotebookPath() {
    // Extract path without leading slash, remove .html extension
    let path = window.location.pathname.replace(/^\//, '') || 'index';
    path = path.replace(/\.html$/, '');
    return path;
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.onclose = null;  // Prevent reconnect loop
        this.ws.onerror = null;
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    this.connecting = false;
    this.connected = false;
    this.connectAttempts = 0;
    setConnectionStatus(false);
  }

  connect() {
    // Bail if the user has flipped the connection off via the UI switch.
    if (!getEnabled()) {
      return;
    }

    // Connect through Vite's WebSocket proxy (same origin as the page)
    // Include notebook path for multi-instance routing
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const notebookPath = encodeURIComponent(this.getNotebookPath());
    const wsUrl = `${wsProtocol}//${window.location.host}/__debug_ws/${notebookPath}`;

    const MAX_CONNECT_ATTEMPTS = 5;

    // Prevent multiple simultaneous connection attempts
    if (this.connecting) {
      return;
    }

    this.connectAttempts++;
    if (this.connectAttempts > MAX_CONNECT_ATTEMPTS) {
      console.log("[DebugClient] Max connection attempts reached, giving up");
      return;
    }

    this.connecting = true;

    // Close any existing WebSocket before creating a new one
    if (this.ws) {
      try {
        this.ws.onclose = null;  // Remove handler to avoid triggering reconnect
        this.ws.onerror = null;
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    try {
      console.log("[DebugClient] Connecting via Vite proxy:", wsUrl, `(attempt ${this.connectAttempts}/${MAX_CONNECT_ATTEMPTS})`);
      this.ws = new WebSocket(wsUrl);

      // Set a connection timeout - if onopen doesn't fire within 3s, retry
      const connectionTimeout = setTimeout(() => {
        if (!this.connected && this.connecting) {
          console.log("[DebugClient] Connection timeout, retrying...");
          this.connecting = false;
          try { this.ws.close(); } catch (e) {}
          setTimeout(() => this.connect(), 500);
        }
      }, 3000);

      this.ws.onopen = () => {
        clearTimeout(connectionTimeout);
        this.connecting = false;
        this.connected = true;
        this.connectAttempts = 0; // Reset on successful connection
        console.log("[DebugClient] Connected to MCP server at", wsUrl);

        setConnectionStatus(true);

        // Identify this client to the server. Sent on every connect (not just
        // the first) so the server knows the URL after reconnects and after
        // the user toggles the connection switch off/on.
        this.ws.send(JSON.stringify({
          type: "session_start",
          sessionId: this.sessionId,
          timestamp: Date.now(),
          data: {
            url: window.location.href,
            userAgent: navigator.userAgent,
          },
        }));

        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          this.ws.send(msg);
        }
      };

      this.ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        const wasConnected = this.connected;
        this.connecting = false;
        this.connected = false;
        setConnectionStatus(false);
        // Only auto-reconnect if we were previously connected (not from a failed connection attempt)
        if (wasConnected) {
          console.log("[DebugClient] Disconnected from MCP server (code:", event.code, "reason:", event.reason || "none", "), reconnecting in", RECONNECT_INTERVAL, "ms");
          setTimeout(() => this.connect(), RECONNECT_INTERVAL);
        }
      };

      this.ws.onerror = (err) => {
        clearTimeout(connectionTimeout);
        console.error("[DebugClient] WebSocket error:", err);
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleServerMessage(message);
        } catch (err) {
          console.error("[DebugClient] Failed to parse server message:", err);
        }
      };
    } catch (err) {
      console.error("[DebugClient] Failed to connect:", err);
      setTimeout(() => this.connect(), RECONNECT_INTERVAL);
    }
  }

  handleServerMessage(message) {
    if (message.type === "Refresh") {
      sessionStorage.setItem(REFRESH_SESSION_KEY, message.sessionId);
      window.location.reload();
      return;
    }

    if (message.type === "Navigate") {
      sessionStorage.setItem(REFRESH_SESSION_KEY, message.sessionId);
      window.location.href = message.url;
      return;
    }

    // Log MCP events to the overlay
    if (message.type) {
      logEvent(message.type, message);
    }

    // Value-centric handlers
    if (message.type === "GetValue") {
      handleGetValueRequest(this, message);
      return;
    }

    if (message.type === "GetValues") {
      handleGetValuesRequest(this, message);
      return;
    }

    if (message.type === "ListValues") {
      handleListValuesRequest(this, message);
      return;
    }

    if (message.type === "GetValueMetadata") {
      handleGetValueMetadataRequest(this, message);
      return;
    }

    // Legacy handlers (for backwards compatibility during transition)
    if (message.type === "GetCellValue") {
      handleGetValueRequest(this, { ...message, name: message.cellName });
      return;
    }

    if (message.type === "ListCells") {
      handleListValuesRequest(this, message);
      return;
    }

    if (message.type === "GetErrors") {
      handleGetErrorsRequest(this, message);
      return;
    }

    if (message.type === "SetInput") {
      handleSetInputRequest(this, message);
      return;
    }

    if (message.type === "GetElementContent") {
      handleGetElementContentRequest(this, message);
      return;
    }

    if (message.type === "GetDependencyGraph") {
      handleGetDependencyGraphRequest(this, message);
      return;
    }

    if (message.type === "BrowserEval") {
      handleBrowserEvalRequest(this, message);
      return;
    }

    if (message.type === "MouseClick") {
      handleMouseClickRequest(this, message);
      return;
    }

    if (message.type === "MouseDrag") {
      handleMouseDragRequest(this, message);
      return;
    }

    if (message.type === "MouseWheel") {
      handleMouseWheelRequest(this, message);
      return;
    }

    if (message.type === "MouseHover") {
      handleMouseHoverRequest(this, message);
      return;
    }

    if (message.type === "SendKeys") {
      handleSendKeysRequest(this, message);
      return;
    }

    if (message.type === "RuntimeEval") {
      handleRuntimeEvalRequest(this, message);
      return;
    }
  }

  send(message) {
    const data = JSON.stringify({
      ...message,
      sessionId: this.sessionId,
      timestamp: message.timestamp || Date.now(),
    });

    // Log responses to the event log UI (link them to their requests)
    if (message.requestId && message.type?.endsWith('_response')) {
      logResponse(message.requestId, message);
    }

    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.messageQueue.push(data);
    }
  }

  endSession() {
    if (this.sessionEnded) return;

    this.sessionEnded = true;

    this.send({
      type: "session_end",
      data: { duration: Date.now() - this.sessionStartTime },
    });

    if (this.errorWatching) {
      if (this.errorWatching.interval) clearInterval(this.errorWatching.interval);
      if (this.errorWatching.observer) this.errorWatching.observer.disconnect();
    }
  }
}
