/**
 * Value-related request handlers
 */

import { getRuntimeModule, getValueState, getVariableMetadata, getValueTypeHint } from "../utils/runtime.js";
import { serializeValue } from "../utils/serialize.js";
import { captureSVGAsImage } from "./elements.js";

/**
 * Handle GetValue request - returns value with state info
 * Automatically captures SVG elements as images
 */
export async function handleGetValueRequest(client, message) {
  const runtime = getRuntimeModule();
  const name = message.name || message.cellName;

  if (!runtime) {
    client.send({
      type: "value_response",
      requestId: message.requestId,
      name,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  const result = await getValueState(runtime, name, message.timeout || 5000);

  if (result.state === "fulfilled") {
    let serializedValue = result.value;

    // Check if the value is an SVG element and capture it as an image
    if (result.value instanceof SVGElement ||
        (result.value instanceof Element && result.value.tagName?.toLowerCase() === 'svg')) {
      try {
        const imageData = await captureSVGAsImage(result.value);
        if (imageData) {
          serializedValue = {
            __type: "SVG",
            width: imageData.width,
            height: imageData.height,
            data: imageData.data,
          };
        } else {
          serializedValue = serializeValue(result.value);
        }
      } catch (err) {
        // Fall back to regular serialization if capture fails
        serializedValue = serializeValue(result.value);
      }
    } else {
      serializedValue = serializeValue(result.value);
    }

    client.send({
      type: "value_response",
      requestId: message.requestId,
      name,
      success: true,
      state: "fulfilled",
      value: serializedValue,
    });
  } else if (result.state === "pending") {
    client.send({
      type: "value_response",
      requestId: message.requestId,
      name,
      success: true,
      state: "pending",
    });
  } else {
    client.send({
      type: "value_response",
      requestId: message.requestId,
      name,
      success: true,
      state: "rejected",
      error: result.error,
      stack: result.stack,
    });
  }
}

/**
 * Handle GetValues request - returns multiple/all values
 */
export async function handleGetValuesRequest(client, message) {
  const runtime = getRuntimeModule();

  if (!runtime || !runtime._scope) {
    client.send({
      type: "values_response",
      requestId: message.requestId,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  // Get list of names to fetch
  let names = message.names;
  if (!names || names.length === 0) {
    // Fetch all values
    names = Array.from(runtime._scope.keys()).filter(
      (name) => !name.startsWith("_")
    );
  }

  const values = {};
  const timeout = message.timeout || 100; // Short timeout for bulk operations

  for (const name of names) {
    const result = await getValueState(runtime, name, timeout);

    if (result.state === "fulfilled") {
      values[name] = {
        state: "fulfilled",
        value: serializeValue(result.value),
      };
    } else if (result.state === "pending") {
      values[name] = { state: "pending" };
    } else {
      values[name] = {
        state: "rejected",
        error: result.error,
      };
    }
  }

  client.send({
    type: "values_response",
    requestId: message.requestId,
    success: true,
    values,
  });
}

/**
 * Handle ListValues request - returns list of all value names
 */
export function handleListValuesRequest(client, message) {
  const runtime = getRuntimeModule();

  if (!runtime || !runtime._scope) {
    client.send({
      type: "values_list_response",
      requestId: message.requestId,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  const values = Array.from(runtime._scope.keys())
    .filter((name) => !name.startsWith("_"))
    .sort();

  client.send({
    type: "values_list_response",
    requestId: message.requestId,
    success: true,
    values,
    // Also send as 'cells' for backwards compatibility
    cells: values,
  });
}

/**
 * Handle GetValueMetadata request - returns type/state/dependencies
 */
export async function handleGetValueMetadataRequest(client, message) {
  const runtime = getRuntimeModule();
  const name = message.name;

  if (!runtime || !runtime._scope) {
    client.send({
      type: "metadata_response",
      requestId: message.requestId,
      name,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  const metadata = getVariableMetadata(runtime, name);

  if (!metadata) {
    client.send({
      type: "metadata_response",
      requestId: message.requestId,
      name,
      success: false,
      error: `${name} is not defined`,
    });
    return;
  }

  // Get state without waiting long for pending values
  const stateResult = await getValueState(runtime, name, 50);

  // Get value type hint without full serialization
  let valueType = null;
  if (stateResult.state === "fulfilled" && stateResult.value !== undefined) {
    valueType = getValueTypeHint(stateResult.value);
  }

  client.send({
    type: "metadata_response",
    requestId: message.requestId,
    name,
    success: true,
    metadata: {
      ...metadata,
      state: stateResult.state,
      valueType,
      error: stateResult.error,
    },
  });
}
