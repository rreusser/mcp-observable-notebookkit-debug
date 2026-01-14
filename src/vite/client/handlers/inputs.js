/**
 * Input handling for SetInput requests
 */

import { getRuntimeModule, getVariable } from "../utils/runtime.js";

/**
 * Handle SetInput request - sets the value of an input element and triggers reactive updates
 */
export async function handleSetInputRequest(client, message) {
  const runtime = getRuntimeModule();
  const name = message.name;
  const newValue = message.value;

  if (!runtime) {
    client.send({
      type: "setinput_response",
      requestId: message.requestId,
      name,
      success: false,
      error: "Observable runtime not found",
    });
    return;
  }

  try {
    // Get the variable which should hold an input element
    const variable = getVariable(runtime, name);
    if (!variable) {
      client.send({
        type: "setinput_response",
        requestId: message.requestId,
        name,
        success: false,
        error: `${name} is not defined`,
      });
      return;
    }

    // Get the current value (should be a DOM element)
    const element = await runtime.value(name);

    if (!element || !(element instanceof Element)) {
      client.send({
        type: "setinput_response",
        requestId: message.requestId,
        name,
        success: false,
        error: `${name} is not a DOM element`,
      });
      return;
    }

    // Check for button elements first - these just need to be clicked
    let buttonEl = null;
    if (element.tagName === 'BUTTON') {
      buttonEl = element;
    } else {
      buttonEl = element.querySelector('button');
    }

    if (buttonEl) {
      // For buttons, just click them regardless of the value passed
      const previousValue = element.value;
      buttonEl.click();

      // Small delay to let reactive updates propagate
      await new Promise(resolve => setTimeout(resolve, 50));

      const resultValue = element.value;
      client.send({
        type: "setinput_response",
        requestId: message.requestId,
        name,
        success: true,
        previousValue,
        newValue: resultValue,
        action: "clicked",
      });
      return;
    }

    // Find the actual input element - could be the element itself or nested inside
    let inputEl = null;
    if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
      inputEl = element;
    } else {
      // Look for input elements inside (common for Observable Inputs which wrap in forms)
      inputEl = element.querySelector('input, select, textarea');
    }

    if (!inputEl) {
      client.send({
        type: "setinput_response",
        requestId: message.requestId,
        name,
        success: false,
        error: `Could not find input element within ${name}`,
      });
      return;
    }

    // Check if the wrapper element has a custom value property (Observable Inputs pattern)
    // Observable Inputs defines a 'value' getter/setter on the wrapper that handles
    // value-to-index mapping for select elements
    const wrapperDescriptor = Object.getOwnPropertyDescriptor(element, 'value');
    const hasWrapperValueSetter = wrapperDescriptor && typeof wrapperDescriptor.set === 'function';

    // Get the previous value - prefer wrapper's value if it has a getter
    let previousValue;
    if (inputEl.tagName === 'SELECT') {
      // For select elements, return the selected option's text (what user sees)
      const selectedOption = inputEl.options[inputEl.selectedIndex];
      previousValue = selectedOption ? selectedOption.text : null;
    } else if (hasWrapperValueSetter && wrapperDescriptor.get) {
      previousValue = element.value;
    } else if (inputEl.type === 'checkbox') {
      previousValue = inputEl.checked;
    } else if (inputEl.type === 'radio') {
      // For radio buttons, find the checked one
      const checkedRadio = element.querySelector('input[type="radio"]:checked');
      previousValue = checkedRadio ? checkedRadio.value : null;
    } else {
      previousValue = inputEl.value;
    }

    // Set the new value
    if (inputEl.type === 'checkbox') {
      // Check if this is a multi-checkbox (Observable Inputs.checkbox) or single (toggle)
      const allCheckboxes = element.querySelectorAll('input[type="checkbox"]');

      if (allCheckboxes.length > 1) {
        // Multi-checkbox: value should be an array of labels to check
        const valuesToCheck = Array.isArray(newValue) ? newValue : [newValue];

        for (const checkbox of allCheckboxes) {
          // Get the label text for this checkbox
          const label = checkbox.closest('label') || element.querySelector(`label[for="${checkbox.id}"]`);
          let labelText = '';
          if (label) {
            labelText = Array.from(label.childNodes)
              .filter(node => node.nodeType === Node.TEXT_NODE)
              .map(node => node.textContent.trim())
              .join('');
          }

          // Check if this checkbox should be checked (match by label text or index)
          const shouldBeChecked = valuesToCheck.some(v =>
            labelText === String(v) || checkbox.value === String(v)
          );
          checkbox.checked = shouldBeChecked;
        }

        // Dispatch event on the wrapper
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // Single checkbox (toggle): treat value as boolean
        inputEl.checked = Boolean(newValue);
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (inputEl.type === 'radio') {
      // For radio buttons, find and check the one with matching value
      // First try matching by value attribute
      let targetRadio = element.querySelector(`input[type="radio"][value="${CSS.escape(String(newValue))}"]`);

      // If not found, try matching by label text (for Observable Inputs which use numeric indices)
      if (!targetRadio) {
        const radios = element.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
          const label = radio.closest('label') || element.querySelector(`label[for="${radio.id}"]`);
          if (label) {
            // Get text content excluding the input element itself
            const labelText = Array.from(label.childNodes)
              .filter(node => node.nodeType === Node.TEXT_NODE)
              .map(node => node.textContent.trim())
              .join('');
            if (labelText === String(newValue)) {
              targetRadio = radio;
              break;
            }
          }
        }
      }

      if (targetRadio) {
        targetRadio.checked = true;
        targetRadio.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl = targetRadio;
      } else {
        client.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `No radio option found with value "${newValue}"`,
        });
        return;
      }
    } else if (inputEl.tagName === 'SELECT') {
      // Handle select elements specially
      // If value is an integer, treat as index; if string, match by option text/value
      const selectEl = inputEl;
      let targetIndex = -1;

      if (Number.isInteger(newValue) && newValue >= 0 && newValue < selectEl.options.length) {
        // Integer provided - use as index
        targetIndex = newValue;
      } else {
        // String provided - try to match by option text or value
        const searchValue = String(newValue);
        for (let i = 0; i < selectEl.options.length; i++) {
          const option = selectEl.options[i];
          // Match by option text (what user sees) or by value attribute
          if (option.text === searchValue || option.value === searchValue) {
            targetIndex = i;
            break;
          }
        }
      }

      if (targetIndex === -1) {
        // List available options in error message
        const availableOptions = Array.from(selectEl.options).map((opt, i) =>
          `${i}: "${opt.text}"`
        ).join(', ');
        client.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `No option found matching "${newValue}". Available options: ${availableOptions}`,
        });
        return;
      }

      // Get the option at the target index
      const targetOption = selectEl.options[targetIndex];

      // Set value - prefer wrapper's value setter if available (Observable Inputs pattern)
      // Observable Inputs uses the option text (display value) as its value, not the value attribute
      if (hasWrapperValueSetter) {
        element.value = targetOption.text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        selectEl.selectedIndex = targetIndex;
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (hasWrapperValueSetter) {
      // Use the wrapper's value setter for other input types with custom setters
      element.value = newValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      inputEl.value = newValue;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Small delay to let reactive updates propagate
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get the resulting value - prefer wrapper's value if available
    let resultValue;
    if (inputEl.tagName === 'SELECT') {
      // For select elements, return the selected option's text (what user sees)
      const selectedOption = inputEl.options[inputEl.selectedIndex];
      resultValue = selectedOption ? selectedOption.text : null;
    } else if (hasWrapperValueSetter && wrapperDescriptor.get) {
      resultValue = element.value;
    } else if (inputEl.type === 'checkbox') {
      resultValue = inputEl.checked;
    } else {
      resultValue = inputEl.value;
    }

    client.send({
      type: "setinput_response",
      requestId: message.requestId,
      name,
      success: true,
      previousValue,
      newValue: resultValue,
    });
  } catch (error) {
    client.send({
      type: "setinput_response",
      requestId: message.requestId,
      name,
      success: false,
      error: error.message,
    });
  }
}
