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
import { handleEvalRequest } from "./handlers/eval.js";
import { handleDefineVariableRequest, handleDeleteVariableRequest, handleListInjectedVariablesRequest } from "./handlers/variables.js";
import { handleMouseClickRequest, handleMouseDragRequest, handleMouseWheelRequest, handleMouseHoverRequest } from "./handlers/mouse.js";
import { handleSendKeysRequest } from "./handlers/keyboard.js";
import { logEvent, initEventLog } from "./ui/event-log.js";

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
    this.messageQueue = [];
    this.originalConsole = {};
    this.errorWatching = null;
    this.sessionStartTime = Date.now();
    this.sessionEnded = false;
    // Track injected ephemeral variables for cleanup
    this.injectedVariables = new Map();
  }

  init() {
    this.connect();
    this.originalConsole = patchConsole(this.send.bind(this));
    this.errorWatching = setupErrorWatching(this.send.bind(this));

    this.send({
      type: "session_start",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: {
        url: window.location.href,
        userAgent: navigator.userAgent,
      },
    });

    setTimeout(() => {
      if (!this.sessionEnded) {
        this.endSession();
      }
    }, SESSION_TIMEOUT);

    window.__debugClient = this;

    this.signalReady();
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

  connect() {
    const wsUrl = `ws://localhost:${this.config.ws}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        console.log("[DebugClient] Connected to MCP server at", wsUrl);

        // Show the event log overlay as soon as we connect
        initEventLog();

        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          this.ws.send(msg);
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        console.log("[DebugClient] Disconnected from MCP server, reconnecting in", RECONNECT_INTERVAL, "ms");
        setTimeout(() => this.connect(), RECONNECT_INTERVAL);
      };

      this.ws.onerror = (err) => {
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

    if (message.type === "Eval") {
      handleEvalRequest(this, message);
      return;
    }

    if (message.type === "DefineVariable") {
      handleDefineVariableRequest(this, message);
      return;
    }

    if (message.type === "DeleteVariable") {
      handleDeleteVariableRequest(this, message);
      return;
    }

    if (message.type === "ListInjectedVariables") {
      handleListInjectedVariablesRequest(this, message);
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
  }

  send(message) {
    const data = JSON.stringify({
      ...message,
      sessionId: this.sessionId,
      timestamp: message.timestamp || Date.now(),
    });

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
