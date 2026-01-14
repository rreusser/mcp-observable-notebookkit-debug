/**
 * Console patching utilities
 */

import { serializeArg } from "./serialize.js";

/**
 * Patch console methods to capture logs
 * @param {Function} send - Function to send messages
 * @returns {Object} - Original console methods for restoration
 */
export function patchConsole(send) {
  const levels = ["log", "info", "warn", "error", "debug"];
  const earlyOriginal = window.__originalConsole || {};
  const originalConsole = {};

  levels.forEach((level) => {
    originalConsole[level] = earlyOriginal[level] || console[level];

    console[level] = (...args) => {
      originalConsole[level](...args);

      send({
        type: "log",
        data: {
          level,
          args: args.map((arg) => serializeArg(arg)),
        },
      });
    };
  });

  // Send any early captured logs
  if (window.__earlyConsoleLogs && window.__earlyConsoleLogs.length > 0) {
    window.__earlyConsoleLogs.forEach((log) => {
      send({
        type: "log",
        timestamp: log.timestamp,
        data: {
          level: log.level,
          args: log.args.map((arg) => serializeArg(arg)),
        },
      });
    });
    window.__earlyConsoleLogs = [];
  }

  return originalConsole;
}
