/**
 * RuntimeEval handler - evaluate expressions in the Observable runtime context
 */

import { getRuntimeModule, getValueState } from "../utils/runtime.js";
import { serializeValueAsync } from "../utils/serialize.js";

/**
 * Detect variable dependencies from an expression by checking which
 * identifiers in the expression match existing runtime variables.
 */
function detectDependencies(runtime, expression) {
  if (!runtime._scope) return [];

  // Get all variable names from the runtime
  const scopeNames = new Set(
    Array.from(runtime._scope.keys()).filter(n => !n.startsWith("_"))
  );

  // Simple identifier extraction using regex
  // This matches word characters that could be variable names
  // It's not perfect but works for common cases
  const identifierPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  const foundIdentifiers = new Set();
  let match;

  while ((match = identifierPattern.exec(expression)) !== null) {
    const id = match[1];
    // Filter out JavaScript keywords and common globals
    if (scopeNames.has(id) && !isJavaScriptKeyword(id)) {
      foundIdentifiers.add(id);
    }
  }

  return Array.from(foundIdentifiers);
}

/**
 * Check if a string is a JavaScript keyword or common global
 */
function isJavaScriptKeyword(word) {
  const keywords = new Set([
    // Keywords
    "break", "case", "catch", "continue", "debugger", "default", "delete",
    "do", "else", "finally", "for", "function", "if", "in", "instanceof",
    "new", "return", "switch", "this", "throw", "try", "typeof", "var",
    "void", "while", "with", "class", "const", "enum", "export", "extends",
    "import", "super", "implements", "interface", "let", "package", "private",
    "protected", "public", "static", "yield", "await", "async",
    // Common globals
    "undefined", "null", "true", "false", "NaN", "Infinity",
    "Array", "Object", "String", "Number", "Boolean", "Function",
    "Math", "Date", "RegExp", "Error", "JSON", "Promise", "Map", "Set",
    "console", "window", "document", "parseInt", "parseFloat", "isNaN",
    "isFinite", "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent"
  ]);
  return keywords.has(word);
}

/**
 * Handle RuntimeEval request - evaluate an expression in the Observable runtime context.
 * The body should contain a return statement.
 * If name starts with _tmp_, the variable is auto-deleted after resolution.
 */
export async function handleRuntimeEvalRequest(client, message) {
  const { name, body, timeout = 10000 } = message;
  const runtime = getRuntimeModule();

  if (!runtime) {
    client.send({
      type: "runtime_eval_response",
      requestId: message.requestId,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  try {
    // Auto-detect dependencies from the body
    const deps = detectDependencies(runtime, body);

    // Build the definition function - body already contains return statement
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction(...deps, body);

    // Delete any existing injected variable with this name
    if (client.injectedVariables.has(name)) {
      client.injectedVariables.get(name).delete();
      client.injectedVariables.delete(name);
    }

    // Create the variable in the runtime
    const variable = runtime.define(name, deps, fn);
    client.injectedVariables.set(name, variable);

    // Wait for the value to be computed
    const result = await getValueState(runtime, name, timeout);

    // Auto-cleanup temporary variables (those starting with _tmp_)
    const isTemporary = name.startsWith("_tmp_");
    if (isTemporary && client.injectedVariables.has(name)) {
      client.injectedVariables.get(name).delete();
      client.injectedVariables.delete(name);
    }

    if (result.state === "fulfilled") {
      client.send({
        type: "runtime_eval_response",
        requestId: message.requestId,
        success: true,
        state: "fulfilled",
        value: await serializeValueAsync(result.value),
      });
    } else if (result.state === "pending") {
      client.send({
        type: "runtime_eval_response",
        requestId: message.requestId,
        success: true,
        state: "pending",
      });
    } else {
      client.send({
        type: "runtime_eval_response",
        requestId: message.requestId,
        success: true,
        state: "rejected",
        error: result.error,
        stack: result.stack,
      });
    }
  } catch (error) {
    client.send({
      type: "runtime_eval_response",
      requestId: message.requestId,
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
}
