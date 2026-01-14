/**
 * Element content and image capture handlers
 */

import { captureSVGAsImage } from "../utils/serialize.js";

/**
 * Handle GetElementContent request - gets content from DOM elements
 * Supports text, HTML, canvas capture, and SVG
 */
export async function handleGetElementContentRequest(client, message) {
  const { selector, mode = 'auto' } = message;

  try {
    const element = document.querySelector(selector);

    if (!element) {
      client.send({
        type: "elementcontent_response",
        requestId: message.requestId,
        selector,
        success: false,
        error: `No element found matching selector: ${selector}`,
      });
      return;
    }

    const tagName = element.tagName.toLowerCase();
    const response = {
      type: "elementcontent_response",
      requestId: message.requestId,
      selector,
      success: true,
      tagName: tagName,
    };

    // Determine element type
    const isCanvas = element instanceof HTMLCanvasElement;
    const isSVG = element instanceof SVGElement || tagName === 'svg';
    const isImage = element instanceof HTMLImageElement;

    // Determine what to capture based on mode and element type
    const shouldCaptureImage = mode === 'image' ||
      (mode === 'auto' && (isCanvas || isSVG));
    const shouldGetText = mode === 'text' ||
      (mode === 'auto' && !isCanvas && !isSVG);
    const shouldGetHTML = mode === 'html';

    // Set element type hint
    if (isCanvas) response.elementType = 'canvas';
    else if (isSVG) response.elementType = 'svg';
    else if (isImage) response.elementType = 'image';
    else response.elementType = 'element';

    // Capture as image if needed
    if (shouldCaptureImage) {
      try {
        const imageData = await captureElementAsImage(element);
        if (imageData) {
          response.imageData = imageData.data;
          response.width = imageData.width;
          response.height = imageData.height;
        }
      } catch (err) {
        response.captureError = err.message;
      }
    }

    // Get SVG source for SVG elements
    if (isSVG && mode !== 'image') {
      response.svgSource = element.outerHTML;
    }

    // Get text content
    if (shouldGetText || mode === 'auto') {
      response.textContent = element.textContent?.trim() || '';
    }

    // Get HTML content
    if (shouldGetHTML) {
      response.innerHTML = element.innerHTML;
    }

    client.send(response);
  } catch (error) {
    client.send({
      type: "elementcontent_response",
      requestId: message.requestId,
      selector,
      success: false,
      error: error.message,
    });
  }
}

/**
 * Capture a DOM element as a PNG image
 * Works for canvas, SVG, and regular elements (via html2canvas-like approach)
 */
export async function captureElementAsImage(element) {
  // For canvas elements, just get the data directly
  if (element instanceof HTMLCanvasElement) {
    return {
      data: element.toDataURL('image/png').split(',')[1],
      width: element.width,
      height: element.height,
    };
  }

  // For SVG elements, render to canvas
  if (element instanceof SVGElement || element.tagName.toLowerCase() === 'svg') {
    return await captureSVGAsImage(element);
  }

  // For other elements, we'd need html2canvas or similar
  // For now, return null and let the text content be used
  return null;
}
