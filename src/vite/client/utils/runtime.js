/**
 * Runtime utilities for interacting with the Observable runtime
 */

/**
 * Find the Observable runtime module
 */
export function getRuntimeModule() {
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

/**
 * Get the Variable object from the runtime scope
 */
export function getVariable(runtime, name) {
  return runtime._scope?.get(name) || null;
}

/**
 * Determine the state of a variable: pending, fulfilled, or rejected
 * Returns { state, value?, error? }
 */
export async function getValueState(runtime, name, timeout = 100) {
  const variable = getVariable(runtime, name);

  if (!variable) {
    return { state: "rejected", error: `${name} is not defined` };
  }

  try {
    // Race between getting the value and a short timeout
    const value = await Promise.race([
      runtime.value(name),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("__pending__")), timeout)
      ),
    ]);
    return { state: "fulfilled", value };
  } catch (err) {
    if (err.message === "__pending__") {
      return { state: "pending" };
    }
    return { state: "rejected", error: err.message, stack: err.stack };
  }
}

/**
 * Get metadata about a variable without fetching its full value
 */
export function getVariableMetadata(runtime, name) {
  const variable = getVariable(runtime, name);

  if (!variable) {
    return null;
  }

  // Get dependency names (inputs)
  const inputs = variable._inputs
    ? variable._inputs
        .map((v) => v._name)
        .filter((n) => n && !n.startsWith("_"))
    : [];

  // Get dependent names (outputs)
  const outputs = variable._outputs
    ? Array.from(variable._outputs)
        .map((v) => v._name)
        .filter((n) => n && !n.startsWith("_"))
    : [];

  return {
    name,
    inputs,
    outputs,
    type: variable._type, // 1=normal, 2=implicit, 3=duplicate
    hasValue: variable._value !== undefined,
  };
}

/**
 * Get a type hint for a value without full serialization
 */
export function getValueTypeHint(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const type = typeof value;
  if (type !== "object") return type;

  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Date) return "Date";
  if (value instanceof RegExp) return "RegExp";
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (value instanceof Error) return `Error: ${value.name}`;
  if (value instanceof HTMLCanvasElement)
    return `Canvas(${value.width}x${value.height})`;
  if (value instanceof Element) return `Element: <${value.tagName.toLowerCase()}>`;
  if (ArrayBuffer.isView(value))
    return `${value.constructor.name}(${value.length})`;

  const proto = Object.getPrototypeOf(value);
  if (proto && proto.constructor && proto.constructor.name !== "Object") {
    return proto.constructor.name;
  }

  const keys = Object.keys(value);
  return `Object(${keys.length} keys)`;
}
