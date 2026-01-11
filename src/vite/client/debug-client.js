(function () {
  if (
    window.location.hostname !== "localhost" &&
    !window.location.hostname.match(/127\\.0\\.0\\.1/)
  )
    return;

  const DEBUG_WS_URL = "ws://localhost:9899";
  const RECONNECT_INTERVAL = 2000;
  const ERROR_CHECK_INTERVAL = 500;
  const SESSION_TIMEOUT = 5000;
  const REFRESH_SESSION_KEY = "__debug_refresh_session";

  class DebugClient {
    constructor() {
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
      this.errorObserver = null;
      this.sessionStartTime = Date.now();
      this.sessionEnded = false;
    }

    init() {
      this.connect();
      this.patchConsole();
      this.watchForErrors();
      this.watchForRuntimeErrors();

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
        const runtime = this.getRuntimeModule();
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
      try {
        this.ws = new WebSocket(DEBUG_WS_URL);

        this.ws.onopen = () => {
          this.connected = true;

          while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            this.ws.send(msg);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
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

      if (message.type === "GetCellValue") {
        this.handleCellValueRequest(message);
        return;
      }

      if (message.type === "ListCells") {
        this.handleListCellsRequest(message);
        return;
      }

      if (message.type === "GetErrors") {
        this.handleGetErrorsRequest(message);
        return;
      }
    }

    getRuntimeModule() {
      if (window.__observableRuntime) return window.__observableRuntime;
      if (window.main) return window.main;

      for (const key of Object.keys(window)) {
        const value = window[key];
        if (value && typeof value.value === "function" && value._scope) {
          return value;
        }
      }

      return null;
    }

    async handleCellValueRequest(message) {
      const runtime = this.getRuntimeModule();

      if (!runtime) {
        this.send({
          type: "cell_value_response",
          requestId: message.requestId,
          cellName: message.cellName,
          success: false,
          error: "Observable runtime not found",
        });
        return;
      }

      try {
        const value = await runtime.value(message.cellName);
        this.send({
          type: "cell_value_response",
          requestId: message.requestId,
          cellName: message.cellName,
          success: true,
          value: this.serializeValue(value),
        });
      } catch (err) {
        this.send({
          type: "cell_value_response",
          requestId: message.requestId,
          cellName: message.cellName,
          success: false,
          error: err.message,
        });
      }
    }

    handleListCellsRequest(message) {
      const runtime = this.getRuntimeModule();

      if (!runtime || !runtime._scope) {
        this.send({
          type: "cells_list_response",
          requestId: message.requestId,
          success: false,
          error: "Observable runtime not found",
        });
        return;
      }

      const cells = Array.from(runtime._scope.keys())
        .filter((name) => !name.startsWith("_"))
        .sort();

      this.send({
        type: "cells_list_response",
        requestId: message.requestId,
        success: true,
        cells,
      });
    }

    async handleGetErrorsRequest(message) {
      const errors = [];

      const errorSelectors = [
        ".observablehq--error",
        ".notebook-error",
        "[data-error]",
        ".error",
      ];

      for (const selector of errorSelectors) {
        document.querySelectorAll(selector).forEach((el) => {
          const cellElement =
            el.closest('[id^="cell-"]') ||
            el.closest("script") ||
            el.parentElement;
          const cellId = cellElement?.id || "unknown";
          const errorText =
            el.textContent?.trim() ||
            el.getAttribute("data-error") ||
            "Unknown error";

          if (!errors.some((e) => e.cell === cellId && e.error === errorText)) {
            errors.push({
              cell: cellId,
              error: errorText,
              source: "dom",
            });
          }
        });
      }

      const runtime = this.getRuntimeModule();
      if (runtime && runtime._scope) {
        const cells = Array.from(runtime._scope.keys()).filter(
          (name) => !name.startsWith("_")
        );

        for (const cellName of cells) {
          try {
            await Promise.race([
              runtime.value(cellName),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 100)
              ),
            ]);
          } catch (err) {
            if (err.message !== "timeout") {
              if (!errors.some((e) => e.cell === cellName)) {
                errors.push({
                  cell: cellName,
                  error: err.message,
                  stack: err.stack,
                  source: "runtime",
                });
              }
            }
          }
        }
      }

      this.send({
        type: "errors_response",
        requestId: message.requestId,
        success: true,
        errors,
      });
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

    patchConsole() {
      const levels = ["log", "info", "warn", "error", "debug"];
      const earlyOriginal = window.__originalConsole || {};

      levels.forEach((level) => {
        this.originalConsole[level] = earlyOriginal[level] || console[level];

        console[level] = (...args) => {
          this.originalConsole[level](...args);

          this.send({
            type: "log",
            data: {
              level,
              args: args.map((arg) => this.serializeArg(arg)),
            },
          });
        };
      });

      if (window.__earlyConsoleLogs && window.__earlyConsoleLogs.length > 0) {
        window.__earlyConsoleLogs.forEach((log) => {
          this.send({
            type: "log",
            timestamp: log.timestamp,
            data: {
              level: log.level,
              args: log.args.map((arg) => this.serializeArg(arg)),
            },
          });
        });
        window.__earlyConsoleLogs = [];
      }
    }

    serializeArg(arg) {
      if (arg === null) return "null";
      if (arg === undefined) return "undefined";

      const type = typeof arg;

      if (type === "string" || type === "number" || type === "boolean") {
        return arg;
      }

      if (type === "function") {
        return "[Function: " + (arg.name || "anonymous") + "]";
      }

      if (arg instanceof Error) {
        return { __type: "Error", message: arg.message, stack: arg.stack };
      }

      if (arg instanceof Element) {
        return "[Element: " + arg.tagName.toLowerCase() + "]";
      }

      if (ArrayBuffer.isView(arg)) {
        return (
          "[TypedArray: " + arg.constructor.name + " length=" + arg.length + "]"
        );
      }

      try {
        const seen = new WeakSet();
        return JSON.parse(
          JSON.stringify(arg, (key, value) => {
            if (typeof value === "object" && value !== null) {
              if (seen.has(value)) return "[Circular]";
              seen.add(value);
            }
            return value;
          })
        );
      } catch (err) {
        return "[Object: " + Object.prototype.toString.call(arg) + "]";
      }
    }

    serializeValue(value, maxDepth, currentDepth, seen) {
      maxDepth = maxDepth || 10;
      currentDepth = currentDepth || 0;
      seen = seen || new WeakMap();

      const MAX_STRING_LENGTH = 10000;
      const MAX_ARRAY_LENGTH = 100;

      if (value === null) return null;
      if (value === undefined) return { __type: "undefined" };

      const type = typeof value;

      if (type === "string") {
        if (value.length > MAX_STRING_LENGTH) {
          return {
            __type: "string",
            value: value.slice(0, MAX_STRING_LENGTH) + "...",
            truncated: true,
            length: value.length,
          };
        }
        return value;
      }

      if (type === "number" || type === "boolean") return value;

      if (type === "function") {
        const source = value.toString();
        return {
          __type: "Function",
          name: value.name || "anonymous",
          source: source.length > 200 ? source.slice(0, 200) + "..." : source,
        };
      }

      if (type === "object") {
        if (seen.has(value))
          return { __type: "Circular", ref: seen.get(value) };
        if (currentDepth >= maxDepth) return { __type: "MaxDepthExceeded" };
        seen.set(value, "ref-" + seen.size);
      }

      if (value instanceof Error) {
        return {
          __type: "Error",
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      if (value instanceof HTMLCanvasElement) {
        try {
          const dataUrl = value.toDataURL("image/png");
          const base64 = dataUrl.split(",")[1];
          return {
            __type: "Canvas",
            width: value.width,
            height: value.height,
            data: base64,
          };
        } catch (err) {
          return {
            __type: "Canvas",
            width: value.width,
            height: value.height,
            error: "Failed to capture: " + err.message,
          };
        }
      }

      if (value instanceof Element) {
        return {
          __type: "Element",
          tagName: value.tagName.toLowerCase(),
          id: value.id,
          className: value.className,
          innerHTML: value.innerHTML.slice(0, 500),
        };
      }

      if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const arr = Array.from(value);
        const sample = arr.length > 10 ? arr.slice(0, 10) : arr;
        return {
          __type: "TypedArray",
          arrayType: value.constructor.name,
          length: value.length,
          sample: sample,
          truncated: arr.length > 10,
        };
      }

      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_LENGTH) {
          return {
            __type: "Array",
            length: value.length,
            sample: value
              .slice(0, 20)
              .map((v) =>
                this.serializeValue(v, maxDepth, currentDepth + 1, seen)
              ),
            truncated: true,
          };
        }
        return value.map((v) =>
          this.serializeValue(v, maxDepth, currentDepth + 1, seen)
        );
      }

      if (value instanceof Date)
        return { __type: "Date", value: value.toISOString() };
      if (value instanceof RegExp)
        return { __type: "RegExp", source: value.source, flags: value.flags };

      if (value instanceof Map) {
        const entries = Array.from(value.entries()).slice(0, MAX_ARRAY_LENGTH);
        return {
          __type: "Map",
          size: value.size,
          entries: entries.map(([k, v]) => [
            this.serializeValue(k, maxDepth, currentDepth + 1, seen),
            this.serializeValue(v, maxDepth, currentDepth + 1, seen),
          ]),
          truncated: value.size > MAX_ARRAY_LENGTH,
        };
      }

      if (value instanceof Set) {
        const values = Array.from(value).slice(0, MAX_ARRAY_LENGTH);
        return {
          __type: "Set",
          size: value.size,
          values: values.map((v) =>
            this.serializeValue(v, maxDepth, currentDepth + 1, seen)
          ),
          truncated: value.size > MAX_ARRAY_LENGTH,
        };
      }

      try {
        const result = {};
        const keys = Object.keys(value);
        const limitedKeys = keys.slice(0, 100);

        for (const key of limitedKeys) {
          try {
            result[key] = this.serializeValue(
              value[key],
              maxDepth,
              currentDepth + 1,
              seen
            );
          } catch (err) {
            result[key] = {
              __type: "Error",
              message: "Serialization failed: " + err.message,
            };
          }
        }

        if (keys.length > limitedKeys.length) {
          result.__truncated = true;
          result.__totalKeys = keys.length;
        }

        return result;
      } catch (err) {
        return {
          __type: "Object",
          error: "Serialization failed: " + err.message,
          toString: Object.prototype.toString.call(value),
        };
      }
    }

    watchForErrors() {
      window.addEventListener("error", (event) => {
        this.send({
          type: "error",
          data: {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error?.stack,
            source: "window.error",
          },
        });
      });

      window.addEventListener("unhandledrejection", (event) => {
        this.send({
          type: "error",
          data: {
            message: "Unhandled Promise Rejection: " + event.reason,
            stack: event.reason?.stack,
            source: "unhandledrejection",
          },
        });
      });
    }

    watchForRuntimeErrors() {
      const checkErrors = () => {
        const errorElements = document.querySelectorAll(".observablehq--error");

        errorElements.forEach((el) => {
          if (el.dataset.debugReported) return;
          el.dataset.debugReported = "true";

          const cellElement = el.closest(".observablehq--cell");
          const cellId = cellElement?.id?.replace("cell-", "") || "unknown";
          const inspectElement = el.querySelector(".observablehq--inspect");
          const message = inspectElement?.textContent || "Unknown error";

          this.send({
            type: "runtime_error",
            data: { message, cellId, html: el.innerHTML.slice(0, 500) },
          });
        });
      };

      this.errorCheckInterval = setInterval(checkErrors, ERROR_CHECK_INTERVAL);

      this.errorObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (
                node.classList?.contains("observablehq--error") ||
                node.querySelector?.(".observablehq--error")
              ) {
                checkErrors();
                break;
              }
            }
          }
        }
      });

      this.errorObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    endSession() {
      if (this.sessionEnded) return;

      this.sessionEnded = true;

      this.send({
        type: "session_end",
        data: { duration: Date.now() - this.sessionStartTime },
      });

      if (this.errorCheckInterval) clearInterval(this.errorCheckInterval);
      if (this.errorObserver) this.errorObserver.disconnect();
    }
  }

  // Initialize debug client - runtime will be found via polling in getRuntimeModule
  function initDebugClient() {
    const client = new DebugClient();
    client.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDebugClient);
  } else {
    initDebugClient();
  }
})();
