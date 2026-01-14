/**
 * Mouse event handlers (MouseClick, MouseDrag, MouseWheel)
 */

/**
 * Get element and compute absolute coordinates for mouse events
 */
function getMouseEventTarget(selector, x = 0, y = 0) {
  let target = document.body;
  let clientX = x;
  let clientY = y;

  if (selector) {
    const el = document.querySelector(selector);
    if (!el) {
      return { error: `Element not found: ${selector}` };
    }
    target = el;
    const rect = el.getBoundingClientRect();
    clientX = rect.left + x;
    clientY = rect.top + y;
  }

  return { target, clientX, clientY };
}

/**
 * Handle MouseClick request - simulate a mouse click
 */
export function handleMouseClickRequest(client, message) {
  const { selector, x = 0, y = 0, button = 0 } = message;

  try {
    const result = getMouseEventTarget(selector, x, y);
    if (result.error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: result.error,
      });
      return;
    }

    const { target, clientX, clientY } = result;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button,
      buttons: 1 << button,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
    };

    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
    target.dispatchEvent(new MouseEvent("click", eventInit));

    client.send({
      type: "mouse_response",
      requestId: message.requestId,
      success: true,
      clientX,
      clientY,
    });
  } catch (error) {
    client.send({
      type: "mouse_response",
      requestId: message.requestId,
      success: false,
      error: error.message,
    });
  }
}

/**
 * Handle MouseDrag request - simulate a mouse drag with animation frames
 * d3-zoom uses mousedown/mousemove/mouseup (not pointer events)
 */
export function handleMouseDragRequest(client, message) {
  const {
    selector,
    startX = 0,
    startY = 0,
    endX = 0,
    endY = 0,
    duration = 300,
    button = 0,
  } = message;

  try {
    const startResult = getMouseEventTarget(selector, startX, startY);
    if (startResult.error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: startResult.error,
      });
      return;
    }

    const endResult = getMouseEventTarget(selector, endX, endY);
    const { target, clientX: startClientX, clientY: startClientY } = startResult;
    const { clientX: endClientX, clientY: endClientY } = endResult;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button,
      buttons: 1 << button,
      clientX: startClientX,
      clientY: startClientY,
      screenX: startClientX,
      screenY: startClientY,
    };

    // d3-zoom listens for mousedown on the element
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));

    const startTime = performance.now();
    let moveCount = 0;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);

      // Linear interpolation
      const currentX = startClientX + (endClientX - startClientX) * t;
      const currentY = startClientY + (endClientY - startClientY) * t;

      // d3-zoom listens for mousemove on window (event.view)
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          ...eventInit,
          clientX: currentX,
          clientY: currentY,
          screenX: currentX,
          screenY: currentY,
        })
      );
      moveCount++;

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // d3-zoom listens for mouseup on window
        window.dispatchEvent(
          new MouseEvent("mouseup", {
            ...eventInit,
            clientX: endClientX,
            clientY: endClientY,
            screenX: endClientX,
            screenY: endClientY,
          })
        );

        client.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: true,
          startClientX,
          startClientY,
          endClientX,
          endClientY,
          moveCount,
          actualDuration: Math.round(performance.now() - startTime),
        });
      }
    };

    requestAnimationFrame(animate);
  } catch (error) {
    client.send({
      type: "mouse_response",
      requestId: message.requestId,
      success: false,
      error: error.message,
    });
  }
}

/**
 * Handle MouseWheel request - simulate a mouse wheel scroll
 * Sends multiple small wheel events over time for smooth animation
 */
export function handleMouseWheelRequest(client, message) {
  const { selector, x = 0, y = 0, duration = 300, deltaX = 0, deltaY = 0 } = message;

  try {
    const result = getMouseEventTarget(selector, x, y);
    if (result.error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: result.error,
      });
      return;
    }

    const { target, clientX, clientY } = result;

    // Send multiple small wheel events for smooth animation
    // Use ~60fps timing (16ms per frame)
    const steps = Math.max(1, Math.round(duration / 16));
    const stepDeltaX = deltaX / steps;
    const stepDeltaY = deltaY / steps;
    let step = 0;

    const sendWheelEvent = () => {
      target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          deltaX: stepDeltaX,
          deltaY: stepDeltaY,
          deltaMode: 0, // DOM_DELTA_PIXEL
        })
      );
      step++;

      if (step < steps) {
        setTimeout(sendWheelEvent, duration / steps);
      } else {
        client.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: true,
          clientX,
          clientY,
        });
      }
    };

    sendWheelEvent();
  } catch (error) {
    client.send({
      type: "mouse_response",
      requestId: message.requestId,
      success: false,
      error: error.message,
    });
  }
}
