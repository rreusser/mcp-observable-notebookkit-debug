/**
 * Error handling request handlers
 */

import { getRuntimeModule, getValueState } from "../utils/runtime.js";

/**
 * Handle GetErrors request - get all errors from DOM and runtime
 */
export async function handleGetErrorsRequest(client, message) {
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

  const runtime = getRuntimeModule();
  if (runtime && runtime._scope) {
    const names = Array.from(runtime._scope.keys()).filter(
      (name) => !name.startsWith("_")
    );

    for (const name of names) {
      const result = await getValueState(runtime, name, 100);
      if (result.state === "rejected") {
        if (!errors.some((e) => e.cell === name)) {
          errors.push({
            cell: name,
            name: name,
            error: result.error,
            stack: result.stack,
            source: "runtime",
          });
        }
      }
    }
  }

  client.send({
    type: "errors_response",
    requestId: message.requestId,
    success: true,
    errors,
  });
}

/**
 * Set up error watching - window errors, unhandled rejections, and DOM mutations
 * @param {Function} send - Function to send messages
 * @returns {Object} - Cleanup functions { interval, observer }
 */
export function setupErrorWatching(send) {
  // Watch for window errors
  window.addEventListener("error", (event) => {
    send({
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

  // Watch for unhandled promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    send({
      type: "error",
      data: {
        message: "Unhandled Promise Rejection: " + event.reason,
        stack: event.reason?.stack,
        source: "unhandledrejection",
      },
    });
  });

  // Check for Observable runtime errors in the DOM
  const checkErrors = () => {
    const errorElements = document.querySelectorAll(".observablehq--error");

    errorElements.forEach((el) => {
      if (el.dataset.debugReported) return;
      el.dataset.debugReported = "true";

      const cellElement = el.closest(".observablehq--cell");
      const cellId = cellElement?.id?.replace("cell-", "") || "unknown";
      const inspectElement = el.querySelector(".observablehq--inspect");
      const message = inspectElement?.textContent || "Unknown error";

      send({
        type: "runtime_error",
        data: { message, cellId, html: el.innerHTML.slice(0, 500) },
      });
    });
  };

  const errorCheckInterval = setInterval(checkErrors, 500);

  const errorObserver = new MutationObserver((mutations) => {
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

  errorObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return {
    interval: errorCheckInterval,
    observer: errorObserver,
  };
}
