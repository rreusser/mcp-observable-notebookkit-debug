/**
 * Eval request handler
 */

import { serializeValue } from "../utils/serialize.js";

/**
 * Handle Eval request - execute arbitrary JavaScript code and return the result
 */
export async function handleEvalRequest(client, message) {
  const { code } = message;

  try {
    // Use Function constructor to create a function from the code
    // We wrap in an async function to support await
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

    // Try to auto-return single expressions by wrapping with return()
    // Fall back to raw code if that causes a syntax error (e.g., multi-statement code)
    let fn;
    try {
      fn = new AsyncFunction(`return (${code})`);
    } catch (syntaxError) {
      fn = new AsyncFunction(code);
    }

    const result = await fn();

    client.send({
      type: "eval_response",
      requestId: message.requestId,
      success: true,
      result: serializeValue(result),
    });
  } catch (error) {
    client.send({
      type: "eval_response",
      requestId: message.requestId,
      success: true, // Request succeeded, but code threw an error
      error: error.message,
      stack: error.stack,
    });
  }
}
