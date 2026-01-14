/**
 * Serialization utilities for values and console arguments
 */

const MAX_STRING_LENGTH = 10000;
const MAX_ARRAY_LENGTH = 100;

/**
 * Serialize a console argument for transmission
 */
export function serializeArg(arg) {
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

/**
 * Serialize a value for transmission, handling complex types
 */
export function serializeValue(value, maxDepth, currentDepth, seen) {
  maxDepth = maxDepth || 10;
  currentDepth = currentDepth || 0;
  seen = seen || new WeakMap();

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
            serializeValue(v, maxDepth, currentDepth + 1, seen)
          ),
        truncated: true,
      };
    }
    return value.map((v) =>
      serializeValue(v, maxDepth, currentDepth + 1, seen)
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
        serializeValue(k, maxDepth, currentDepth + 1, seen),
        serializeValue(v, maxDepth, currentDepth + 1, seen),
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
        serializeValue(v, maxDepth, currentDepth + 1, seen)
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
        result[key] = serializeValue(
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
