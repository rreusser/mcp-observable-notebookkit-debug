/**
 * Ephemeral variable handlers (DefineVariable, DeleteVariable, ListInjectedVariables)
 */

import { getRuntimeModule, getValueState } from "../utils/runtime.js";
import { serializeValue } from "../utils/serialize.js";

/**
 * Handle DefineVariable request - inject an ephemeral variable into the Observable runtime
 * The variable participates in the reactive graph and can depend on existing variables.
 *
 * Accepts either:
 * - { name, inputs, expression } - explicit dependencies and expression string
 * - { name, expression } - auto-detect dependencies from expression
 */
export async function handleDefineVariableRequest(client, message) {
  const { name, inputs, expression } = message;
  const runtime = getRuntimeModule();

  if (!runtime) {
    client.send({
      type: "define_response",
      requestId: message.requestId,
      name,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  try {
    // If inputs not provided, try to auto-detect from expression
    let deps = inputs;
    if (!deps) {
      deps = detectDependencies(runtime, expression);
    }

    // Build the definition function
    // The function receives resolved values of dependencies in order
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction(...deps, `return (${expression})`);

    // Check for collision with notebook-defined variables
    if (runtime._scope && runtime._scope.has(name) && !client.injectedVariables.has(name)) {
      client.send({
        type: "define_response",
        requestId: message.requestId,
        name,
        success: false,
        error: `Cannot define "${name}": a variable with this name already exists in the notebook`,
      });
      return;
    }

    // Delete any existing injected variable with this name
    if (client.injectedVariables.has(name)) {
      client.injectedVariables.get(name).delete();
      client.injectedVariables.delete(name);
    }

    // Create the new variable in the runtime
    const variable = runtime.define(name, deps, fn);
    client.injectedVariables.set(name, variable);

    // Wait for the value to be computed
    const result = await getValueState(runtime, name, message.timeout || 5000);

    if (result.state === "fulfilled") {
      client.send({
        type: "define_response",
        requestId: message.requestId,
        name,
        success: true,
        state: "fulfilled",
        value: serializeValue(result.value),
        inputs: deps,
      });
    } else if (result.state === "pending") {
      client.send({
        type: "define_response",
        requestId: message.requestId,
        name,
        success: true,
        state: "pending",
        inputs: deps,
      });
    } else {
      client.send({
        type: "define_response",
        requestId: message.requestId,
        name,
        success: true,
        state: "rejected",
        error: result.error,
        stack: result.stack,
        inputs: deps,
      });
    }
  } catch (error) {
    client.send({
      type: "define_response",
      requestId: message.requestId,
      name,
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
}

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
 * Handle DeleteVariable request - remove an injected ephemeral variable
 */
export async function handleDeleteVariableRequest(client, message) {
  const { name } = message;

  if (!client.injectedVariables.has(name)) {
    client.send({
      type: "delete_response",
      requestId: message.requestId,
      name,
      success: false,
      error: `No injected variable named "${name}" found`,
    });
    return;
  }

  try {
    const variable = client.injectedVariables.get(name);
    variable.delete();
    client.injectedVariables.delete(name);

    client.send({
      type: "delete_response",
      requestId: message.requestId,
      name,
      success: true,
    });
  } catch (error) {
    client.send({
      type: "delete_response",
      requestId: message.requestId,
      name,
      success: false,
      error: error.message,
    });
  }
}

/**
 * Handle ListInjectedVariables request - list all ephemeral variables
 */
export function handleListInjectedVariablesRequest(client, message) {
  const names = Array.from(client.injectedVariables.keys());

  client.send({
    type: "injected_list_response",
    requestId: message.requestId,
    success: true,
    variables: names,
  });
}
