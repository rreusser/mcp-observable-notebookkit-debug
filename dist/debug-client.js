(() => {
  // src/vite/client/utils/runtime.js
  function getRuntimeModule() {
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
  function getVariable(runtime, name) {
    return runtime._scope?.get(name) || null;
  }
  async function getValueState(runtime, name, timeout = 100) {
    const variable = getVariable(runtime, name);
    if (!variable) {
      return { state: "rejected", error: `${name} is not defined` };
    }
    try {
      const value = await Promise.race([
        runtime.value(name),
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("__pending__")), timeout)
        )
      ]);
      return { state: "fulfilled", value };
    } catch (err) {
      if (err.message === "__pending__") {
        return { state: "pending" };
      }
      return { state: "rejected", error: err.message, stack: err.stack };
    }
  }
  function getVariableMetadata(runtime, name) {
    const variable = getVariable(runtime, name);
    if (!variable) {
      return null;
    }
    const inputs = variable._inputs ? variable._inputs.map((v) => v._name).filter((n) => n && !n.startsWith("_")) : [];
    const outputs = variable._outputs ? Array.from(variable._outputs).map((v) => v._name).filter((n) => n && !n.startsWith("_")) : [];
    return {
      name,
      inputs,
      outputs,
      type: variable._type,
      // 1=normal, 2=implicit, 3=duplicate
      hasValue: variable._value !== void 0
    };
  }
  function getValueTypeHint(value) {
    if (value === null) return "null";
    if (value === void 0) return "undefined";
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

  // src/vite/client/utils/serialize.js
  var MAX_STRING_LENGTH = 1e4;
  var MAX_ARRAY_LENGTH = 100;
  function serializeArg(arg) {
    if (arg === null) return "null";
    if (arg === void 0) return "undefined";
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
      return "[TypedArray: " + arg.constructor.name + " length=" + arg.length + "]";
    }
    try {
      const seen = /* @__PURE__ */ new WeakSet();
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
  function serializeValue(value, maxDepth, currentDepth, seen) {
    maxDepth = maxDepth || 10;
    currentDepth = currentDepth || 0;
    seen = seen || /* @__PURE__ */ new WeakMap();
    if (value === null) return null;
    if (value === void 0) return { __type: "undefined" };
    const type = typeof value;
    if (type === "string") {
      if (value.length > MAX_STRING_LENGTH) {
        return {
          __type: "string",
          value: value.slice(0, MAX_STRING_LENGTH) + "...",
          truncated: true,
          length: value.length
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
        source: source.length > 200 ? source.slice(0, 200) + "..." : source
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
        stack: value.stack
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
          data: base64
        };
      } catch (err) {
        return {
          __type: "Canvas",
          width: value.width,
          height: value.height,
          error: "Failed to capture: " + err.message
        };
      }
    }
    if (value instanceof Element) {
      return {
        __type: "Element",
        tagName: value.tagName.toLowerCase(),
        id: value.id,
        className: value.className,
        innerHTML: value.innerHTML.slice(0, 500)
      };
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const arr = Array.from(value);
      const sample = arr.length > 10 ? arr.slice(0, 10) : arr;
      return {
        __type: "TypedArray",
        arrayType: value.constructor.name,
        length: value.length,
        sample,
        truncated: arr.length > 10
      };
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        return {
          __type: "Array",
          length: value.length,
          sample: value.slice(0, 20).map(
            (v) => serializeValue(v, maxDepth, currentDepth + 1, seen)
          ),
          truncated: true
        };
      }
      return value.map(
        (v) => serializeValue(v, maxDepth, currentDepth + 1, seen)
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
          serializeValue(v, maxDepth, currentDepth + 1, seen)
        ]),
        truncated: value.size > MAX_ARRAY_LENGTH
      };
    }
    if (value instanceof Set) {
      const values = Array.from(value).slice(0, MAX_ARRAY_LENGTH);
      return {
        __type: "Set",
        size: value.size,
        values: values.map(
          (v) => serializeValue(v, maxDepth, currentDepth + 1, seen)
        ),
        truncated: value.size > MAX_ARRAY_LENGTH
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
            message: "Serialization failed: " + err.message
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
        toString: Object.prototype.toString.call(value)
      };
    }
  }
  async function serializeValueAsync(value) {
    if (value instanceof HTMLCanvasElement) {
      try {
        return {
          __type: "Canvas",
          width: value.width,
          height: value.height,
          data: value.toDataURL("image/png").split(",")[1]
        };
      } catch (err) {
        return {
          __type: "Canvas",
          width: value.width,
          height: value.height,
          error: "Failed to capture: " + err.message
        };
      }
    }
    if (value instanceof SVGElement || value instanceof Element && value.tagName?.toLowerCase() === "svg") {
      try {
        const imageData = await captureSVGAsImage(value);
        if (imageData) {
          return {
            __type: "SVG",
            width: imageData.width,
            height: imageData.height,
            data: imageData.data
          };
        }
      } catch (err) {
      }
    }
    return serializeValue(value);
  }
  function captureSVGAsImage(svgElement) {
    return new Promise((resolve, reject) => {
      try {
        const clone = svgElement.cloneNode(true);
        const bbox = svgElement.getBoundingClientRect();
        const width = bbox.width || svgElement.getAttribute("width") || 300;
        const height = bbox.height || svgElement.getAttribute("height") || 150;
        clone.setAttribute("width", width);
        clone.setAttribute("height", height);
        const serializer = new XMLSerializer();
        const svgString = serializer.serializeToString(clone);
        const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve({
            data: canvas.toDataURL("image/png").split(",")[1],
            width,
            height
          });
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Failed to load SVG as image"));
        };
        img.src = url;
      } catch (err) {
        reject(err);
      }
    });
  }

  // src/vite/client/utils/console.js
  function patchConsole(send) {
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
            args: args.map((arg) => serializeArg(arg))
          }
        });
      };
    });
    if (window.__earlyConsoleLogs && window.__earlyConsoleLogs.length > 0) {
      window.__earlyConsoleLogs.forEach((log) => {
        send({
          type: "log",
          timestamp: log.timestamp,
          data: {
            level: log.level,
            args: log.args.map((arg) => serializeArg(arg))
          }
        });
      });
      window.__earlyConsoleLogs = [];
    }
    return originalConsole;
  }

  // src/vite/client/handlers/errors.js
  async function handleGetErrorsRequest(client, message) {
    const verbose = message.verbose || false;
    const errors = [];
    const runtime = getRuntimeModule();
    if (runtime && runtime._scope) {
      const names = Array.from(runtime._scope.keys()).filter(
        (name) => !name.startsWith("_")
      );
      for (const name of names) {
        const result = await getValueState(runtime, name, 100);
        if (result.state === "rejected") {
          const errorEntry = {
            name,
            error: result.error
          };
          if (verbose && result.stack) {
            errorEntry.stack = result.stack;
          }
          errors.push(errorEntry);
        }
      }
    }
    client.send({
      type: "errors_response",
      requestId: message.requestId,
      success: true,
      errors
    });
  }
  function setupErrorWatching(send) {
    window.addEventListener("error", (event) => {
      send({
        type: "error",
        data: {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack,
          source: "window.error"
        }
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      send({
        type: "error",
        data: {
          message: "Unhandled Promise Rejection: " + event.reason,
          stack: event.reason?.stack,
          source: "unhandledrejection"
        }
      });
    });
    const checkErrors = () => {
      const errorElements = document.querySelectorAll(".observablehq--error");
      errorElements.forEach((el) => {
        if (el.dataset.debugReported) return;
        el.dataset.debugReported = "true";
        const cellElement = el.closest(".observablehq--cell");
        const cellId = cellElement?.id?.replace("cell-", "") || "unknown";
        const inspectElement = el.querySelector(".observablehq--inspect");
        const message = inspectElement?.textContent || "Unknown error";
        send({
          type: "runtime_error",
          data: { message, cellId, html: el.innerHTML.slice(0, 500) }
        });
      });
    };
    const errorCheckInterval = setInterval(checkErrors, 500);
    const errorObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains("observablehq--error") || node.querySelector?.(".observablehq--error")) {
              checkErrors();
              break;
            }
          }
        }
      }
    });
    errorObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    return {
      interval: errorCheckInterval,
      observer: errorObserver
    };
  }

  // src/vite/client/handlers/values.js
  async function handleGetValueRequest(client, message) {
    const runtime = getRuntimeModule();
    const name = message.name || message.cellName;
    if (!runtime) {
      client.send({
        type: "value_response",
        requestId: message.requestId,
        name,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    const result = await getValueState(runtime, name, message.timeout || 5e3);
    if (result.state === "fulfilled") {
      const serializedValue = await serializeValueAsync(result.value);
      client.send({
        type: "value_response",
        requestId: message.requestId,
        name,
        success: true,
        state: "fulfilled",
        value: serializedValue
      });
    } else if (result.state === "pending") {
      client.send({
        type: "value_response",
        requestId: message.requestId,
        name,
        success: true,
        state: "pending"
      });
    } else {
      client.send({
        type: "value_response",
        requestId: message.requestId,
        name,
        success: true,
        state: "rejected",
        error: result.error,
        stack: result.stack
      });
    }
  }
  async function handleGetValuesRequest(client, message) {
    const runtime = getRuntimeModule();
    if (!runtime || !runtime._scope) {
      client.send({
        type: "values_response",
        requestId: message.requestId,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    let names = message.names;
    if (!names || names.length === 0) {
      names = Array.from(runtime._scope.keys()).filter(
        (name) => !name.startsWith("_")
      );
    }
    const values = {};
    const timeout = message.timeout || 100;
    for (const name of names) {
      const result = await getValueState(runtime, name, timeout);
      if (result.state === "fulfilled") {
        values[name] = {
          state: "fulfilled",
          value: serializeValue(result.value)
        };
      } else if (result.state === "pending") {
        values[name] = { state: "pending" };
      } else {
        values[name] = {
          state: "rejected",
          error: result.error
        };
      }
    }
    client.send({
      type: "values_response",
      requestId: message.requestId,
      success: true,
      values
    });
  }
  function handleListValuesRequest(client, message) {
    const runtime = getRuntimeModule();
    if (!runtime || !runtime._scope) {
      client.send({
        type: "values_list_response",
        requestId: message.requestId,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    const values = Array.from(runtime._scope.keys()).filter((name) => !name.startsWith("_")).sort();
    client.send({
      type: "values_list_response",
      requestId: message.requestId,
      success: true,
      values,
      // Also send as 'cells' for backwards compatibility
      cells: values
    });
  }
  async function handleGetValueMetadataRequest(client, message) {
    const runtime = getRuntimeModule();
    const name = message.name;
    if (!runtime || !runtime._scope) {
      client.send({
        type: "metadata_response",
        requestId: message.requestId,
        name,
        success: false,
        error: "Observable runtime not found"
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
        error: `${name} is not defined`
      });
      return;
    }
    const stateResult = await getValueState(runtime, name, 50);
    let valueType = null;
    if (stateResult.state === "fulfilled" && stateResult.value !== void 0) {
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
        error: stateResult.error
      }
    });
  }

  // src/vite/client/handlers/inputs.js
  async function handleSetInputRequest(client, message) {
    const runtime = getRuntimeModule();
    const name = message.name;
    const newValue = message.value;
    if (!runtime) {
      client.send({
        type: "setinput_response",
        requestId: message.requestId,
        name,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    try {
      const variable = getVariable(runtime, name);
      if (!variable) {
        client.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `${name} is not defined`
        });
        return;
      }
      const element = await runtime.value(name);
      if (!element || !(element instanceof Element)) {
        client.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `${name} is not a DOM element`
        });
        return;
      }
      let buttonEl = null;
      if (element.tagName === "BUTTON") {
        buttonEl = element;
      } else {
        buttonEl = element.querySelector("button");
      }
      if (buttonEl) {
        const previousValue2 = element.value;
        buttonEl.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const resultValue2 = element.value;
        client.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: true,
          previousValue: previousValue2,
          newValue: resultValue2,
          action: "clicked"
        });
        return;
      }
      let inputEl = null;
      if (element.tagName === "INPUT" || element.tagName === "SELECT" || element.tagName === "TEXTAREA") {
        inputEl = element;
      } else {
        inputEl = element.querySelector("input, select, textarea");
      }
      if (!inputEl) {
        client.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `Could not find input element within ${name}`
        });
        return;
      }
      const wrapperDescriptor = Object.getOwnPropertyDescriptor(element, "value");
      const hasWrapperValueSetter = wrapperDescriptor && typeof wrapperDescriptor.set === "function";
      let previousValue;
      if (inputEl.tagName === "SELECT") {
        const selectedOption = inputEl.options[inputEl.selectedIndex];
        previousValue = selectedOption ? selectedOption.text : null;
      } else if (hasWrapperValueSetter && wrapperDescriptor.get) {
        previousValue = element.value;
      } else if (inputEl.type === "checkbox") {
        previousValue = inputEl.checked;
      } else if (inputEl.type === "radio") {
        const checkedRadio = element.querySelector('input[type="radio"]:checked');
        previousValue = checkedRadio ? checkedRadio.value : null;
      } else {
        previousValue = inputEl.value;
      }
      if (inputEl.type === "checkbox") {
        const allCheckboxes = element.querySelectorAll('input[type="checkbox"]');
        if (allCheckboxes.length > 1) {
          const valuesToCheck = Array.isArray(newValue) ? newValue : [newValue];
          for (const checkbox of allCheckboxes) {
            const label = checkbox.closest("label") || element.querySelector(`label[for="${checkbox.id}"]`);
            let labelText = "";
            if (label) {
              labelText = Array.from(label.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent.trim()).join("");
            }
            const shouldBeChecked = valuesToCheck.some(
              (v) => labelText === String(v) || checkbox.value === String(v)
            );
            checkbox.checked = shouldBeChecked;
          }
          element.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          inputEl.checked = Boolean(newValue);
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (inputEl.type === "radio") {
        let targetRadio = element.querySelector(`input[type="radio"][value="${CSS.escape(String(newValue))}"]`);
        if (!targetRadio) {
          const radios = element.querySelectorAll('input[type="radio"]');
          for (const radio of radios) {
            const label = radio.closest("label") || element.querySelector(`label[for="${radio.id}"]`);
            if (label) {
              const labelText = Array.from(label.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent.trim()).join("");
              if (labelText === String(newValue)) {
                targetRadio = radio;
                break;
              }
            }
          }
        }
        if (targetRadio) {
          targetRadio.checked = true;
          targetRadio.dispatchEvent(new Event("input", { bubbles: true }));
          inputEl = targetRadio;
        } else {
          client.send({
            type: "setinput_response",
            requestId: message.requestId,
            name,
            success: false,
            error: `No radio option found with value "${newValue}"`
          });
          return;
        }
      } else if (inputEl.tagName === "SELECT") {
        const selectEl = inputEl;
        let targetIndex = -1;
        if (Number.isInteger(newValue) && newValue >= 0 && newValue < selectEl.options.length) {
          targetIndex = newValue;
        } else {
          const searchValue = String(newValue);
          for (let i = 0; i < selectEl.options.length; i++) {
            const option = selectEl.options[i];
            if (option.text === searchValue || option.value === searchValue) {
              targetIndex = i;
              break;
            }
          }
        }
        if (targetIndex === -1) {
          const availableOptions = Array.from(selectEl.options).map(
            (opt, i) => `${i}: "${opt.text}"`
          ).join(", ");
          client.send({
            type: "setinput_response",
            requestId: message.requestId,
            name,
            success: false,
            error: `No option found matching "${newValue}". Available options: ${availableOptions}`
          });
          return;
        }
        const targetOption = selectEl.options[targetIndex];
        if (hasWrapperValueSetter) {
          element.value = targetOption.text;
          element.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          selectEl.selectedIndex = targetIndex;
          selectEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (hasWrapperValueSetter) {
        element.value = newValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        inputEl.value = newValue;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      let resultValue;
      if (inputEl.tagName === "SELECT") {
        const selectedOption = inputEl.options[inputEl.selectedIndex];
        resultValue = selectedOption ? selectedOption.text : null;
      } else if (hasWrapperValueSetter && wrapperDescriptor.get) {
        resultValue = element.value;
      } else if (inputEl.type === "checkbox") {
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
        newValue: resultValue
      });
    } catch (error) {
      client.send({
        type: "setinput_response",
        requestId: message.requestId,
        name,
        success: false,
        error: error.message
      });
    }
  }

  // src/vite/client/handlers/elements.js
  async function handleGetElementContentRequest(client, message) {
    const { selector } = message;
    try {
      const element = document.querySelector(selector);
      if (!element) {
        client.send({
          type: "elementcontent_response",
          requestId: message.requestId,
          selector,
          success: false,
          error: `No element found matching selector: ${selector}`
        });
        return;
      }
      const tagName = element.tagName.toLowerCase();
      const response = {
        type: "elementcontent_response",
        requestId: message.requestId,
        selector,
        success: true,
        tagName
      };
      const isCanvas = element instanceof HTMLCanvasElement;
      const isSVG = element instanceof SVGElement || tagName === "svg";
      if (isCanvas) response.elementType = "canvas";
      else if (isSVG) response.elementType = "svg";
      else response.elementType = "element";
      if (isCanvas || isSVG) {
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
        if (isSVG) {
          response.svgSource = element.outerHTML;
        }
      } else {
        response.textContent = element.textContent?.trim() || "";
        response.innerHTML = element.innerHTML;
      }
      client.send(response);
    } catch (error) {
      client.send({
        type: "elementcontent_response",
        requestId: message.requestId,
        selector,
        success: false,
        error: error.message
      });
    }
  }
  async function captureElementAsImage(element) {
    if (element instanceof HTMLCanvasElement) {
      return {
        data: element.toDataURL("image/png").split(",")[1],
        width: element.width,
        height: element.height
      };
    }
    if (element instanceof SVGElement || element.tagName.toLowerCase() === "svg") {
      return await captureSVGAsImage(element);
    }
    return null;
  }

  // src/vite/client/handlers/graph.js
  async function handleGetDependencyGraphRequest(client, message) {
    const runtime = getRuntimeModule();
    const filters = message.filters || {};
    if (!runtime || !runtime._scope) {
      client.send({
        type: "dependencygraph_response",
        requestId: message.requestId,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    try {
      const allNodes = [];
      const allEdges = [];
      const scope = runtime._scope;
      const nodeMap = /* @__PURE__ */ new Map();
      const isAnonymousValue = (name) => /^cell \d+$/.test(name);
      const matchesPattern = (name, pattern) => {
        if (!pattern) return true;
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
        return regex.test(name);
      };
      for (const [name, variable] of scope.entries()) {
        if (name.startsWith("_")) continue;
        const stateResult = await getValueState(runtime, name, 50);
        let valueType = null;
        if (stateResult.state === "fulfilled" && stateResult.value !== void 0) {
          valueType = getValueTypeHint(stateResult.value);
        }
        const inputs = variable._inputs ? variable._inputs.map((v) => v._name).filter((n) => n && !n.startsWith("_")) : [];
        const outputs = variable._outputs ? Array.from(variable._outputs).map((v) => v._name).filter((n) => n && !n.startsWith("_")) : [];
        const node = {
          name,
          state: stateResult.state,
          valueType,
          inputs,
          outputs
        };
        allNodes.push(node);
        nodeMap.set(name, node);
        for (const input of inputs) {
          allEdges.push({
            from: input,
            to: name
          });
        }
      }
      let filteredNodeNames = /* @__PURE__ */ new Set();
      if (filters.name) {
        const focusNode = nodeMap.get(filters.name);
        if (!focusNode) {
          client.send({
            type: "dependencygraph_response",
            requestId: message.requestId,
            success: false,
            error: `Node "${filters.name}" not found`
          });
          return;
        }
        filteredNodeNames.add(filters.name);
        const maxDepth = filters.depth >= 0 ? filters.depth : Infinity;
        if (filters.direction === "both" || filters.direction === "upstream") {
          const traverse = (nodeName, currentDepth) => {
            if (currentDepth > maxDepth) return;
            const node = nodeMap.get(nodeName);
            if (!node) return;
            for (const input of node.inputs) {
              if (!filteredNodeNames.has(input)) {
                filteredNodeNames.add(input);
                traverse(input, currentDepth + 1);
              }
            }
          };
          traverse(filters.name, 0);
        }
        if (filters.direction === "both" || filters.direction === "downstream") {
          const traverse = (nodeName, currentDepth) => {
            if (currentDepth > maxDepth) return;
            const node = nodeMap.get(nodeName);
            if (!node) return;
            for (const output of node.outputs) {
              if (!filteredNodeNames.has(output)) {
                filteredNodeNames.add(output);
                traverse(output, currentDepth + 1);
              }
            }
          };
          traverse(filters.name, 0);
        }
      } else if (filters.pattern) {
        for (const node of allNodes) {
          if (matchesPattern(node.name, filters.pattern)) {
            filteredNodeNames.add(node.name);
          }
        }
      } else {
        for (const node of allNodes) {
          filteredNodeNames.add(node.name);
        }
      }
      if (!filters.include_anonymous) {
        filteredNodeNames = new Set(
          [...filteredNodeNames].filter((name) => !isAnonymousValue(name))
        );
      }
      const nodes = allNodes.filter((n) => filteredNodeNames.has(n.name));
      const edges = allEdges.filter(
        (e) => filteredNodeNames.has(e.from) && filteredNodeNames.has(e.to)
      );
      for (const node of nodes) {
        node.inputs = node.inputs.filter((n) => filteredNodeNames.has(n));
        node.outputs = node.outputs.filter((n) => filteredNodeNames.has(n));
      }
      nodes.sort((a, b) => {
        const aIsRoot = a.inputs.length === 0;
        const bIsRoot = b.inputs.length === 0;
        if (aIsRoot && !bIsRoot) return -1;
        if (!aIsRoot && bIsRoot) return 1;
        return a.name.localeCompare(b.name);
      });
      client.send({
        type: "dependencygraph_response",
        requestId: message.requestId,
        success: true,
        graph: { nodes, edges }
      });
    } catch (error) {
      client.send({
        type: "dependencygraph_response",
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }

  // src/vite/client/handlers/eval.js
  async function handleBrowserEvalRequest(client, message) {
    const { code } = message;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function() {
      }).constructor;
      let fn;
      try {
        fn = new AsyncFunction(`return (${code})`);
      } catch (syntaxError) {
        fn = new AsyncFunction(code);
      }
      const result = await fn();
      client.send({
        type: "browser_eval_response",
        requestId: message.requestId,
        success: true,
        result: await serializeValueAsync(result)
      });
    } catch (error) {
      client.send({
        type: "browser_eval_response",
        requestId: message.requestId,
        success: true,
        // Request succeeded, but code threw an error
        error: error.message,
        stack: error.stack
      });
    }
  }

  // src/vite/client/handlers/variables.js
  function detectDependencies(runtime, expression) {
    if (!runtime._scope) return [];
    const scopeNames = new Set(
      Array.from(runtime._scope.keys()).filter((n) => !n.startsWith("_"))
    );
    const identifierPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    const foundIdentifiers = /* @__PURE__ */ new Set();
    let match;
    while ((match = identifierPattern.exec(expression)) !== null) {
      const id = match[1];
      if (scopeNames.has(id) && !isJavaScriptKeyword(id)) {
        foundIdentifiers.add(id);
      }
    }
    return Array.from(foundIdentifiers);
  }
  function isJavaScriptKeyword(word) {
    const keywords = /* @__PURE__ */ new Set([
      // Keywords
      "break",
      "case",
      "catch",
      "continue",
      "debugger",
      "default",
      "delete",
      "do",
      "else",
      "finally",
      "for",
      "function",
      "if",
      "in",
      "instanceof",
      "new",
      "return",
      "switch",
      "this",
      "throw",
      "try",
      "typeof",
      "var",
      "void",
      "while",
      "with",
      "class",
      "const",
      "enum",
      "export",
      "extends",
      "import",
      "super",
      "implements",
      "interface",
      "let",
      "package",
      "private",
      "protected",
      "public",
      "static",
      "yield",
      "await",
      "async",
      // Common globals
      "undefined",
      "null",
      "true",
      "false",
      "NaN",
      "Infinity",
      "Array",
      "Object",
      "String",
      "Number",
      "Boolean",
      "Function",
      "Math",
      "Date",
      "RegExp",
      "Error",
      "JSON",
      "Promise",
      "Map",
      "Set",
      "console",
      "window",
      "document",
      "parseInt",
      "parseFloat",
      "isNaN",
      "isFinite",
      "encodeURI",
      "decodeURI",
      "encodeURIComponent",
      "decodeURIComponent"
    ]);
    return keywords.has(word);
  }
  async function handleRuntimeEvalRequest(client, message) {
    const { name, body, timeout = 1e4 } = message;
    const runtime = getRuntimeModule();
    if (!runtime) {
      client.send({
        type: "runtime_eval_response",
        requestId: message.requestId,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    try {
      const deps = detectDependencies(runtime, body);
      const AsyncFunction = Object.getPrototypeOf(async function() {
      }).constructor;
      const fn = new AsyncFunction(...deps, body);
      if (client.injectedVariables.has(name)) {
        client.injectedVariables.get(name).delete();
        client.injectedVariables.delete(name);
      }
      const variable = runtime.define(name, deps, fn);
      client.injectedVariables.set(name, variable);
      const result = await getValueState(runtime, name, timeout);
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
          value: await serializeValueAsync(result.value)
        });
      } else if (result.state === "pending") {
        client.send({
          type: "runtime_eval_response",
          requestId: message.requestId,
          success: true,
          state: "pending"
        });
      } else {
        client.send({
          type: "runtime_eval_response",
          requestId: message.requestId,
          success: true,
          state: "rejected",
          error: result.error,
          stack: result.stack
        });
      }
    } catch (error) {
      client.send({
        type: "runtime_eval_response",
        requestId: message.requestId,
        success: false,
        error: error.message,
        stack: error.stack
      });
    }
  }

  // src/vite/client/ui/mouse-visualizer.js
  var initialized = false;
  var styleEl = null;
  var styles = `
.mcp-mouse-viz {
  position: absolute;
  pointer-events: none;
  z-index: 99998;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace;
}

/* ============================================
   CLICK - Red/Pink theme
   ============================================ */
.mcp-click-ripple {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: rgba(20, 20, 20, 0.9);
  border: 2px solid #ff4d6a;
  transform: translate(-50%, -50%) scale(0.25);
  animation: mcp-ripple 1.5s ease-out forwards;
  box-shadow: 0 0 16px #ff4d6a, 0 0 32px rgba(255, 77, 106, 0.5);
}

.mcp-click-ripple::after {
  content: 'CLICK';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  text-align: center;
  color: #ff4d6a;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-shadow: 0 0 10px #ff4d6a;
  animation: mcp-label-fade 1.5s ease-out forwards;
}

@keyframes mcp-ripple {
  0% {
    transform: translate(-50%, -50%) scale(0.35);
    opacity: 1;
  }
  70% {
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -50%) scale(1.25);
    opacity: 0;
  }
}

@keyframes mcp-label-fade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}

/* ============================================
   HOVER - Green theme
   Strict render order:
   1) Crosshair STROKE + glow
   2) Circle STROKE + glow
   3) Crosshair FILL
   4) Circle FILL
   ============================================ */
.mcp-hover-indicator {
  width: 40px;
  height: 40px;
  transform: translate(-50%, -50%);
  animation: mcp-hover-in 0.3s ease-out forwards;
}

/* 1. Crosshair STROKE + glow (no fill) */
.mcp-hover-crosshair-stroke {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}

.mcp-hover-crosshair-stroke::before,
.mcp-hover-crosshair-stroke::after {
  content: '';
  position: absolute;
  background: #4ade80;
  border-radius: 3px;
  box-shadow: 0 0 12px #4ade80, 0 0 24px rgba(74, 222, 128, 0.5);
}

.mcp-hover-crosshair-stroke::before {
  top: 50%;
  left: 0;
  right: 0;
  height: 6px;
  transform: translateY(-50%);
}

.mcp-hover-crosshair-stroke::after {
  left: 50%;
  top: 0;
  bottom: 0;
  width: 6px;
  transform: translateX(-50%);
}

/* 2. Circle STROKE + glow (no fill) */
.mcp-hover-circle-stroke {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 14px;
  height: 14px;
  background: #4ade80;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 8px #4ade80, 0 0 16px rgba(74, 222, 128, 0.5);
}

/* 3. Crosshair FILL (no stroke, no glow) */
.mcp-hover-crosshair-fill {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}

.mcp-hover-crosshair-fill::before,
.mcp-hover-crosshair-fill::after {
  content: '';
  position: absolute;
  background: rgba(20, 20, 20, 0.95);
  border-radius: 2px;
}

.mcp-hover-crosshair-fill::before {
  top: 50%;
  left: 1px;
  right: 1px;
  height: 2px;
  transform: translateY(-50%);
}

.mcp-hover-crosshair-fill::after {
  left: 50%;
  top: 1px;
  bottom: 1px;
  width: 2px;
  transform: translateX(-50%);
}

/* 4. Circle FILL (no stroke, no glow) */
.mcp-hover-circle-fill {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  background: rgba(20, 20, 20, 0.95);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

/* Label */
.mcp-hover-label {
  position: absolute;
  top: -24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(20, 20, 20, 0.95);
  border: 1.5px solid #4ade80;
  border-radius: 3px;
  padding: 2px 6px;
  color: #4ade80;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
  box-shadow: 0 0 8px #4ade80, 0 0 16px rgba(74, 222, 128, 0.4);
}

@keyframes mcp-hover-in {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.3);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

.mcp-hover-indicator.fading {
  animation: mcp-hover-out 0.5s ease-in forwards;
}

@keyframes mcp-hover-out {
  0% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.5);
  }
}

/* ============================================
   DRAG - Yellow/Orange theme
   Strict render order:
   1) All STROKES + glows (start, line, end)
   2) All FILLS (start, line, end)
   ============================================ */

/* Stroke elements */
.mcp-drag-start-stroke {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fbbf24;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 10px #fbbf24, 0 0 20px rgba(251, 191, 36, 0.4);
}

.mcp-drag-line-stroke {
  height: 4px;
  margin-top: -2px;
  background: #fbbf24;
  border-radius: 2px;
  transform-origin: left center;
  box-shadow: 0 0 8px #fbbf24, 0 0 16px rgba(251, 191, 36, 0.4);
  --line-angle: 0deg;
}

.mcp-drag-end-stroke {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fbbf24;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 10px #fbbf24, 0 0 20px rgba(251, 191, 36, 0.4);
}

/* Fill elements */
.mcp-drag-start-fill {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(20, 20, 20, 0.95);
  transform: translate(-50%, -50%);
}

.mcp-drag-line-fill {
  height: 1px;
  margin-top: -0.5px;
  background: rgba(20, 20, 20, 0.95);
  border-radius: 0.5px;
  transform-origin: left center;
  --line-angle: 0deg;
}

.mcp-drag-end-fill {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(20, 20, 20, 0.95);
  transform: translate(-50%, -50%);
}

/* Labels - positioned above circles (20px diameter = 10px radius) */
.mcp-drag-label {
  position: absolute;
  transform: translate(-50%, -100%);
  margin-top: -14px;
  background: rgba(20, 20, 20, 0.95);
  border: 1.5px solid #fbbf24;
  border-radius: 3px;
  padding: 2px 5px;
  color: #fbbf24;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
  box-shadow: 0 0 6px #fbbf24;
}

/* Center dot for end point */
.mcp-drag-end-dot {
  width: 6px;
  height: 6px;
  background: #fbbf24;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 5px #fbbf24;
}

@keyframes mcp-drag-pulse {
  0% { transform: translate(-50%, -50%) scale(0.3); opacity: 0; }
  50% { transform: translate(-50%, -50%) scale(1.2); }
  100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
}

@keyframes mcp-drag-end-pop {
  0% { transform: translate(-50%, -50%) scale(0.3); opacity: 0; }
  60% { transform: translate(-50%, -50%) scale(1.3); opacity: 1; }
  100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
}

@keyframes mcp-line-draw {
  0% { transform: rotate(var(--line-angle)) scaleX(0); opacity: 0; }
  100% { transform: rotate(var(--line-angle)) scaleX(1); opacity: 1; }
}

.mcp-drag-group.fading {
  animation: mcp-fade-out 0.8s ease-in forwards;
}

@keyframes mcp-fade-out {
  0% { opacity: 1; }
  100% { opacity: 0; }
}

/* ============================================
   WHEEL/SCROLL - Blue theme
   ============================================ */
.mcp-wheel-indicator {
  width: 55px;
  height: 55px;
  transform: translate(-50%, -50%);
  animation: mcp-wheel-in 0.2s ease-out forwards;
}

.mcp-wheel-indicator .mcp-wheel-circle {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: 2px solid #60a5fa;
  border-radius: 50%;
  background: rgba(20, 20, 20, 0.9);
  box-shadow: 0 0 12px #60a5fa, 0 0 24px rgba(96, 165, 250, 0.4);
}

.mcp-wheel-indicator .mcp-wheel-arrow {
  position: absolute;
  left: 50%;
  width: 10px;
  height: 10px;
  border-left: 2px solid #60a5fa;
  border-top: 2px solid #60a5fa;
  filter: drop-shadow(0 0 3px #60a5fa);
}

.mcp-wheel-indicator .mcp-wheel-arrow.up {
  top: 8px;
  transform: translateX(-50%) rotate(45deg);
  transform-origin: center center;
  animation: mcp-arrow-bounce-up 0.3s ease-out infinite;
}

.mcp-wheel-indicator .mcp-wheel-arrow.down {
  bottom: 8px;
  transform: translateX(-50%) rotate(-135deg);
  transform-origin: center center;
  animation: mcp-arrow-bounce-down 0.3s ease-out infinite;
}

.mcp-wheel-indicator .mcp-wheel-label {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #60a5fa;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-shadow: 0 0 6px #60a5fa;
}

@keyframes mcp-wheel-in {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
  100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

@keyframes mcp-arrow-bounce-up {
  0%, 100% { transform: translateX(-50%) translateY(0) rotate(45deg); }
  50% { transform: translateX(-50%) translateY(-4px) rotate(45deg); }
}

@keyframes mcp-arrow-bounce-down {
  0%, 100% { transform: translateX(-50%) translateY(0) rotate(-135deg); }
  50% { transform: translateX(-50%) translateY(4px) rotate(-135deg); }
}

.mcp-wheel-indicator.fading {
  animation: mcp-wheel-out 0.4s ease-in forwards;
}

@keyframes mcp-wheel-out {
  0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
}

/* ============================================
   ELEMENT HIGHLIGHT - Cyan theme
   ============================================ */
.mcp-element-highlight {
  box-sizing: border-box;
  border: 2px solid #22d3ee;
  background: rgba(34, 211, 238, 0.1);
  border-radius: 4px;
  box-shadow: 0 0 12px rgba(34, 211, 238, 0.6), inset 0 0 20px rgba(34, 211, 238, 0.1);
  animation: mcp-highlight-in 0.2s ease-out forwards;
}

.mcp-element-highlight-label {
  position: absolute;
  top: -24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(20, 20, 20, 0.95);
  border: 1.5px solid #22d3ee;
  border-radius: 3px;
  padding: 2px 6px;
  color: #22d3ee;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
  box-shadow: 0 0 8px rgba(34, 211, 238, 0.6);
}

@keyframes mcp-highlight-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}

.mcp-element-highlight.fading {
  animation: mcp-highlight-out 0.3s ease-in forwards;
}

@keyframes mcp-highlight-out {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
`;
  function init() {
    if (initialized) return;
    initialized = true;
    styleEl = document.createElement("style");
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);
  }
  function createEl(className) {
    init();
    const el = document.createElement("div");
    el.className = `mcp-mouse-viz ${className}`;
    document.body.appendChild(el);
    return el;
  }
  function positionAt(el, x, y) {
    el.style.left = `${x + window.scrollX}px`;
    el.style.top = `${y + window.scrollY}px`;
  }
  function showClick(clientX, clientY) {
    const el = createEl("mcp-click-ripple");
    positionAt(el, clientX, clientY);
    setTimeout(() => el.remove(), 1500);
  }
  function showHover(clientX, clientY) {
    const el = createEl("mcp-hover-indicator");
    const crosshairStroke = document.createElement("div");
    crosshairStroke.className = "mcp-hover-crosshair-stroke";
    el.appendChild(crosshairStroke);
    const circleStroke = document.createElement("div");
    circleStroke.className = "mcp-hover-circle-stroke";
    el.appendChild(circleStroke);
    const crosshairFill = document.createElement("div");
    crosshairFill.className = "mcp-hover-crosshair-fill";
    el.appendChild(crosshairFill);
    const circleFill = document.createElement("div");
    circleFill.className = "mcp-hover-circle-fill";
    el.appendChild(circleFill);
    const label = document.createElement("div");
    label.className = "mcp-hover-label";
    label.textContent = "HOVER";
    el.appendChild(label);
    positionAt(el, clientX, clientY);
    const timeout = setTimeout(() => {
      el.classList.add("fading");
      setTimeout(() => el.remove(), 500);
    }, 3e3);
    return () => {
      clearTimeout(timeout);
      el.classList.add("fading");
      setTimeout(() => el.remove(), 500);
    };
  }
  function showDrag(startX, startY, endX, endY) {
    const group = createEl("mcp-drag-group");
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const dx = endX - startX;
    const dy = endY - startY;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const startStroke = document.createElement("div");
    startStroke.className = "mcp-drag-start-stroke";
    startStroke.style.position = "absolute";
    startStroke.style.left = `${startX + scrollX}px`;
    startStroke.style.top = `${startY + scrollY}px`;
    group.appendChild(startStroke);
    const lineStroke = document.createElement("div");
    lineStroke.className = "mcp-drag-line-stroke";
    lineStroke.style.position = "absolute";
    lineStroke.style.left = `${startX + scrollX}px`;
    lineStroke.style.top = `${startY + scrollY}px`;
    lineStroke.style.width = `${length}px`;
    lineStroke.style.transform = `rotate(${angle}deg)`;
    group.appendChild(lineStroke);
    const endStroke = document.createElement("div");
    endStroke.className = "mcp-drag-end-stroke";
    endStroke.style.position = "absolute";
    endStroke.style.left = `${endX + scrollX}px`;
    endStroke.style.top = `${endY + scrollY}px`;
    group.appendChild(endStroke);
    const startFill = document.createElement("div");
    startFill.className = "mcp-drag-start-fill";
    startFill.style.position = "absolute";
    startFill.style.left = `${startX + scrollX}px`;
    startFill.style.top = `${startY + scrollY}px`;
    group.appendChild(startFill);
    const lineFill = document.createElement("div");
    lineFill.className = "mcp-drag-line-fill";
    lineFill.style.position = "absolute";
    lineFill.style.left = `${startX + scrollX}px`;
    lineFill.style.top = `${startY + scrollY}px`;
    lineFill.style.width = `${length}px`;
    lineFill.style.transform = `rotate(${angle}deg)`;
    group.appendChild(lineFill);
    const endFill = document.createElement("div");
    endFill.className = "mcp-drag-end-fill";
    endFill.style.position = "absolute";
    endFill.style.left = `${endX + scrollX}px`;
    endFill.style.top = `${endY + scrollY}px`;
    group.appendChild(endFill);
    const startLabel = document.createElement("div");
    startLabel.className = "mcp-drag-label";
    startLabel.textContent = "START";
    startLabel.style.position = "absolute";
    startLabel.style.left = `${startX + scrollX}px`;
    startLabel.style.top = `${startY + scrollY}px`;
    group.appendChild(startLabel);
    const endLabel = document.createElement("div");
    endLabel.className = "mcp-drag-label";
    endLabel.textContent = "END";
    endLabel.style.position = "absolute";
    endLabel.style.left = `${endX + scrollX}px`;
    endLabel.style.top = `${endY + scrollY}px`;
    group.appendChild(endLabel);
    const endDot = document.createElement("div");
    endDot.className = "mcp-drag-end-dot";
    endDot.style.position = "absolute";
    endDot.style.left = `${endX + scrollX}px`;
    endDot.style.top = `${endY + scrollY}px`;
    group.appendChild(endDot);
    setTimeout(() => {
      group.classList.add("fading");
      setTimeout(() => group.remove(), 800);
    }, 3e3);
  }
  function startLiveDrag(startX, startY) {
    init();
    const group = document.createElement("div");
    group.className = "mcp-mouse-viz mcp-drag-group";
    document.body.appendChild(group);
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const startStroke = document.createElement("div");
    startStroke.className = "mcp-drag-start-stroke";
    startStroke.style.position = "absolute";
    startStroke.style.left = `${startX + scrollX}px`;
    startStroke.style.top = `${startY + scrollY}px`;
    group.appendChild(startStroke);
    const lineStroke = document.createElement("div");
    lineStroke.className = "mcp-drag-line-stroke";
    lineStroke.style.position = "absolute";
    lineStroke.style.left = `${startX + scrollX}px`;
    lineStroke.style.top = `${startY + scrollY}px`;
    lineStroke.style.width = "0px";
    lineStroke.style.transform = "rotate(0deg)";
    group.appendChild(lineStroke);
    const endStroke = document.createElement("div");
    endStroke.className = "mcp-drag-end-stroke";
    endStroke.style.position = "absolute";
    endStroke.style.left = `${startX + scrollX}px`;
    endStroke.style.top = `${startY + scrollY}px`;
    endStroke.style.opacity = "0";
    group.appendChild(endStroke);
    const startFill = document.createElement("div");
    startFill.className = "mcp-drag-start-fill";
    startFill.style.position = "absolute";
    startFill.style.left = `${startX + scrollX}px`;
    startFill.style.top = `${startY + scrollY}px`;
    group.appendChild(startFill);
    const lineFill = document.createElement("div");
    lineFill.className = "mcp-drag-line-fill";
    lineFill.style.position = "absolute";
    lineFill.style.left = `${startX + scrollX}px`;
    lineFill.style.top = `${startY + scrollY}px`;
    lineFill.style.width = "0px";
    lineFill.style.transform = "rotate(0deg)";
    group.appendChild(lineFill);
    const endFill = document.createElement("div");
    endFill.className = "mcp-drag-end-fill";
    endFill.style.position = "absolute";
    endFill.style.left = `${startX + scrollX}px`;
    endFill.style.top = `${startY + scrollY}px`;
    endFill.style.opacity = "0";
    group.appendChild(endFill);
    const startLabel = document.createElement("div");
    startLabel.className = "mcp-drag-label";
    startLabel.textContent = "START";
    startLabel.style.position = "absolute";
    startLabel.style.left = `${startX + scrollX}px`;
    startLabel.style.top = `${startY + scrollY}px`;
    group.appendChild(startLabel);
    const endLabel = document.createElement("div");
    endLabel.className = "mcp-drag-label";
    endLabel.textContent = "END";
    endLabel.style.position = "absolute";
    endLabel.style.opacity = "0";
    group.appendChild(endLabel);
    const endDot = document.createElement("div");
    endDot.className = "mcp-drag-end-dot";
    endDot.style.position = "absolute";
    endDot.style.opacity = "0";
    group.appendChild(endDot);
    return {
      /**
       * Update the drag line to current position
       */
      update(currentX, currentY) {
        const dx = currentX - startX;
        const dy = currentY - startY;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        lineStroke.style.width = `${length}px`;
        lineStroke.style.transform = `rotate(${angle}deg)`;
        lineFill.style.width = `${length}px`;
        lineFill.style.transform = `rotate(${angle}deg)`;
      },
      /**
       * Complete the drag - show end point and schedule fade out
       */
      end(endX, endY) {
        const dx = endX - startX;
        const dy = endY - startY;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        lineStroke.style.width = `${length}px`;
        lineStroke.style.transform = `rotate(${angle}deg)`;
        lineFill.style.width = `${length}px`;
        lineFill.style.transform = `rotate(${angle}deg)`;
        endStroke.style.left = `${endX + scrollX}px`;
        endStroke.style.top = `${endY + scrollY}px`;
        endStroke.style.opacity = "1";
        endFill.style.left = `${endX + scrollX}px`;
        endFill.style.top = `${endY + scrollY}px`;
        endFill.style.opacity = "1";
        endLabel.style.left = `${endX + scrollX}px`;
        endLabel.style.top = `${endY + scrollY}px`;
        endLabel.style.opacity = "1";
        endDot.style.left = `${endX + scrollX}px`;
        endDot.style.top = `${endY + scrollY}px`;
        endDot.style.opacity = "1";
        setTimeout(() => {
          group.classList.add("fading");
          setTimeout(() => group.remove(), 800);
        }, 2e3);
      },
      /**
       * Cancel/remove the visualization
       */
      cancel() {
        group.remove();
      }
    };
  }
  function showWheel(clientX, clientY, deltaY) {
    const el = createEl("mcp-wheel-indicator");
    positionAt(el, clientX, clientY);
    const circle = document.createElement("div");
    circle.className = "mcp-wheel-circle";
    el.appendChild(circle);
    const arrow = document.createElement("div");
    arrow.className = `mcp-wheel-arrow ${deltaY > 0 ? "down" : "up"}`;
    el.appendChild(arrow);
    const label = document.createElement("div");
    label.className = "mcp-wheel-label";
    label.textContent = "SCROLL";
    el.appendChild(label);
    setTimeout(() => {
      el.classList.add("fading");
      setTimeout(() => el.remove(), 400);
    }, 1500);
  }
  var currentHighlight = null;
  function showElementHighlight(selector) {
    hideElementHighlight();
    if (!selector) return;
    const el = document.querySelector(selector);
    if (!el) return;
    init();
    const rect = el.getBoundingClientRect();
    const highlight = document.createElement("div");
    highlight.className = "mcp-mouse-viz mcp-element-highlight";
    highlight.style.position = "absolute";
    highlight.style.left = `${rect.left + window.scrollX}px`;
    highlight.style.top = `${rect.top + window.scrollY}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    const label = document.createElement("div");
    label.className = "mcp-element-highlight-label";
    label.textContent = "ELEMENT";
    highlight.appendChild(label);
    document.body.appendChild(highlight);
    currentHighlight = highlight;
  }
  function hideElementHighlight() {
    if (currentHighlight) {
      currentHighlight.classList.add("fading");
      const el = currentHighlight;
      setTimeout(() => el.remove(), 300);
      currentHighlight = null;
    }
  }
  if (typeof window !== "undefined") {
    window.__mcpMouseViz = { showClick, showHover, showDrag, showWheel, showElementHighlight, hideElementHighlight };
  }

  // src/vite/client/handlers/mouse.js
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
  function handleMouseClickRequest(client, message) {
    const { selector, x = 0, y = 0, button = 0 } = message;
    try {
      const result = getMouseEventTarget(selector, x, y);
      if (result.error) {
        client.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: false,
          error: result.error
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
        screenY: clientY
      };
      target.dispatchEvent(new MouseEvent("mousedown", eventInit));
      target.dispatchEvent(new MouseEvent("mouseup", eventInit));
      target.dispatchEvent(new MouseEvent("click", eventInit));
      showClick(clientX, clientY);
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: true,
        clientX,
        clientY
      });
    } catch (error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }
  function handleMouseDragRequest(client, message) {
    const {
      selector,
      startX = 0,
      startY = 0,
      endX = 0,
      endY = 0,
      duration = 300,
      button = 0
    } = message;
    try {
      const startResult = getMouseEventTarget(selector, startX, startY);
      if (startResult.error) {
        client.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: false,
          error: startResult.error
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
        screenY: startClientY
      };
      const dragViz = startLiveDrag(startClientX, startClientY);
      target.dispatchEvent(new MouseEvent("mousedown", eventInit));
      const startTime = performance.now();
      let moveCount = 0;
      const animate = () => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        const currentX = startClientX + (endClientX - startClientX) * t;
        const currentY = startClientY + (endClientY - startClientY) * t;
        dragViz.update(currentX, currentY);
        document.dispatchEvent(
          new MouseEvent("mousemove", {
            ...eventInit,
            clientX: currentX,
            clientY: currentY,
            screenX: currentX,
            screenY: currentY
          })
        );
        moveCount++;
        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          document.dispatchEvent(
            new MouseEvent("mouseup", {
              ...eventInit,
              clientX: endClientX,
              clientY: endClientY,
              screenX: endClientX,
              screenY: endClientY
            })
          );
          dragViz.end(endClientX, endClientY);
          client.send({
            type: "mouse_response",
            requestId: message.requestId,
            success: true,
            startClientX,
            startClientY,
            endClientX,
            endClientY,
            moveCount,
            actualDuration: Math.round(performance.now() - startTime)
          });
        }
      };
      requestAnimationFrame(animate);
    } catch (error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }
  function handleMouseWheelRequest(client, message) {
    const { selector, x = 0, y = 0, duration = 300, deltaX = 0, deltaY = 0 } = message;
    try {
      const result = getMouseEventTarget(selector, x, y);
      if (result.error) {
        client.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: false,
          error: result.error
        });
        return;
      }
      const { target, clientX, clientY } = result;
      showWheel(clientX, clientY, deltaY);
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
            deltaMode: 0
            // DOM_DELTA_PIXEL
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
            clientY
          });
        }
      };
      sendWheelEvent();
    } catch (error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }
  function handleMouseHoverRequest(client, message) {
    const { selector, x = 0, y = 0 } = message;
    try {
      const result = getMouseEventTarget(selector, x, y);
      if (result.error) {
        client.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: false,
          error: result.error
        });
        return;
      }
      const { target, clientX, clientY } = result;
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY
      };
      const pointerInit = {
        ...eventInit,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: 0
      };
      target.dispatchEvent(new PointerEvent("pointerenter", { ...pointerInit, bubbles: false }));
      target.dispatchEvent(new PointerEvent("pointerover", pointerInit));
      target.dispatchEvent(new PointerEvent("pointermove", pointerInit));
      target.dispatchEvent(new MouseEvent("mouseenter", { ...eventInit, bubbles: false }));
      target.dispatchEvent(new MouseEvent("mouseover", eventInit));
      target.dispatchEvent(new MouseEvent("mousemove", eventInit));
      showHover(clientX, clientY);
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: true,
        clientX,
        clientY
      });
    } catch (error) {
      client.send({
        type: "mouse_response",
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }

  // src/vite/client/handlers/keyboard.js
  function handleSendKeysRequest(client, message) {
    const { selector, keys, modifiers = {} } = message;
    try {
      let target = document.activeElement || document.body;
      if (selector) {
        const el = document.querySelector(selector);
        if (!el) {
          client.send({
            type: "keyboard_response",
            requestId: message.requestId,
            success: false,
            error: `Element not found: ${selector}`
          });
          return;
        }
        target = el;
        if (typeof target.focus === "function") {
          target.focus();
        }
      }
      const { ctrlKey = false, altKey = false, shiftKey = false, metaKey = false } = modifiers;
      const keySequence = parseKeys(keys);
      let keysSent = 0;
      for (const keyInfo of keySequence) {
        const eventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          key: keyInfo.key,
          code: keyInfo.code,
          keyCode: keyInfo.keyCode,
          which: keyInfo.keyCode,
          ctrlKey: keyInfo.ctrlKey ?? ctrlKey,
          altKey: keyInfo.altKey ?? altKey,
          shiftKey: keyInfo.shiftKey ?? shiftKey,
          metaKey: keyInfo.metaKey ?? metaKey
        };
        const keydownEvent = new KeyboardEvent("keydown", eventInit);
        target.dispatchEvent(keydownEvent);
        if (keyInfo.printable && !keydownEvent.defaultPrevented) {
          target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
          if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
            const start = target.selectionStart ?? target.value.length;
            const end = target.selectionEnd ?? target.value.length;
            target.value = target.value.slice(0, start) + keyInfo.key + target.value.slice(end);
            target.selectionStart = target.selectionEnd = start + 1;
            target.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        keysSent++;
      }
      client.send({
        type: "keyboard_response",
        requestId: message.requestId,
        success: true,
        keysSent,
        target: target.tagName.toLowerCase() + (target.id ? `#${target.id}` : "")
      });
    } catch (error) {
      client.send({
        type: "keyboard_response",
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }
  function parseKeys(keys) {
    const result = [];
    let i = 0;
    while (i < keys.length) {
      if (keys[i] === "{") {
        const end = keys.indexOf("}", i);
        if (end === -1) {
          result.push(charToKeyInfo(keys[i]));
          i++;
        } else {
          const special = keys.slice(i + 1, end);
          result.push(specialKeyToKeyInfo(special));
          i = end + 1;
        }
      } else {
        result.push(charToKeyInfo(keys[i]));
        i++;
      }
    }
    return result;
  }
  function charToKeyInfo(char) {
    const code = `Key${char.toUpperCase()}`;
    const keyCode = char.toUpperCase().charCodeAt(0);
    return {
      key: char,
      code,
      keyCode,
      printable: true,
      shiftKey: char !== char.toLowerCase()
    };
  }
  function specialKeyToKeyInfo(special) {
    const parts = special.split("+");
    let modifiers = {};
    let keyName = special;
    if (parts.length > 1) {
      keyName = parts[parts.length - 1];
      for (let i = 0; i < parts.length - 1; i++) {
        const mod = parts[i].toLowerCase();
        if (mod === "ctrl" || mod === "control") modifiers.ctrlKey = true;
        else if (mod === "alt") modifiers.altKey = true;
        else if (mod === "shift") modifiers.shiftKey = true;
        else if (mod === "meta" || mod === "cmd" || mod === "command") modifiers.metaKey = true;
      }
    }
    if (keyName.length === 1) {
      return { ...charToKeyInfo(keyName), ...modifiers };
    }
    const specialKeys = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13, printable: false },
      Tab: { key: "Tab", code: "Tab", keyCode: 9, printable: false },
      Escape: { key: "Escape", code: "Escape", keyCode: 27, printable: false },
      Esc: { key: "Escape", code: "Escape", keyCode: 27, printable: false },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, printable: false },
      Delete: { key: "Delete", code: "Delete", keyCode: 46, printable: false },
      Space: { key: " ", code: "Space", keyCode: 32, printable: true },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, printable: false },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, printable: false },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, printable: false },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, printable: false },
      Home: { key: "Home", code: "Home", keyCode: 36, printable: false },
      End: { key: "End", code: "End", keyCode: 35, printable: false },
      PageUp: { key: "PageUp", code: "PageUp", keyCode: 33, printable: false },
      PageDown: { key: "PageDown", code: "PageDown", keyCode: 34, printable: false },
      Insert: { key: "Insert", code: "Insert", keyCode: 45, printable: false },
      F1: { key: "F1", code: "F1", keyCode: 112, printable: false },
      F2: { key: "F2", code: "F2", keyCode: 113, printable: false },
      F3: { key: "F3", code: "F3", keyCode: 114, printable: false },
      F4: { key: "F4", code: "F4", keyCode: 115, printable: false },
      F5: { key: "F5", code: "F5", keyCode: 116, printable: false },
      F6: { key: "F6", code: "F6", keyCode: 117, printable: false },
      F7: { key: "F7", code: "F7", keyCode: 118, printable: false },
      F8: { key: "F8", code: "F8", keyCode: 119, printable: false },
      F9: { key: "F9", code: "F9", keyCode: 120, printable: false },
      F10: { key: "F10", code: "F10", keyCode: 121, printable: false },
      F11: { key: "F11", code: "F11", keyCode: 122, printable: false },
      F12: { key: "F12", code: "F12", keyCode: 123, printable: false }
    };
    const keyInfo = specialKeys[keyName];
    if (keyInfo) {
      return { ...keyInfo, ...modifiers };
    }
    return {
      key: keyName,
      code: keyName,
      keyCode: 0,
      printable: false,
      ...modifiers
    };
  }

  // src/vite/client/ui/event-log.js
  var TOAST_DURATION = 2500;
  var MAX_EVENTS = 50;
  var EXPANDED_STORAGE_KEY = "__mcp_event_log_expanded";
  var MOUSE_EVENTS = ["MouseClick", "MouseHover", "MouseDrag", "MouseWheel"];
  var ELEMENT_EVENTS = ["GetElementContent"];
  var container = null;
  var toastContainer = null;
  var historyPanel = null;
  var detailPanel = null;
  var toggleButton = null;
  var expanded = false;
  var events = [];
  var eventsByRequestId = /* @__PURE__ */ new Map();
  var selectedEventIndex = null;
  var styles2 = `
.mcp-event-log {
  position: fixed;
  bottom: 12px;
  right: 12px;
  z-index: 99999;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace;
  font-size: 11px;
  pointer-events: none;
}

.mcp-event-log * {
  box-sizing: border-box;
}

.mcp-event-log-toggle {
  pointer-events: auto;
  position: absolute;
  bottom: 0;
  right: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(30, 30, 30, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.mcp-event-log-toggle:hover {
  background: rgba(50, 50, 50, 0.95);
  color: rgba(255, 255, 255, 0.9);
  border-color: rgba(255, 255, 255, 0.2);
}

.mcp-event-log-toggle.expanded {
  background: rgba(60, 60, 60, 0.95);
  color: #6ee7b7;
}

.mcp-event-log-toasts {
  position: absolute;
  bottom: 36px;
  right: 0;
  display: flex;
  flex-direction: column-reverse;
  gap: 6px;
  pointer-events: none;
}

.mcp-toast {
  background: rgba(30, 30, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 10px;
  color: #6ee7b7;
  white-space: nowrap;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: mcp-toast-in 0.2s ease-out;
  transform-origin: bottom right;
}

.mcp-toast-label {
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.9em;
  margin-left: 4px;
}

.mcp-toast.fading {
  animation: mcp-toast-out 0.3s ease-in forwards;
}

@keyframes mcp-toast-in {
  from {
    opacity: 0;
    transform: translateX(10px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

@keyframes mcp-toast-out {
  from {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateX(10px) scale(0.95);
  }
}

.mcp-event-log-history {
  pointer-events: auto;
  position: absolute;
  bottom: 36px;
  right: 0;
  width: 280px;
  max-height: 400px;
  background: rgba(24, 24, 24, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  overflow: hidden;
  display: none;
  flex-direction: column;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.mcp-event-log-history.visible {
  display: flex;
}

.mcp-event-log-header {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mcp-event-log-clear {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
}

.mcp-event-log-clear:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
}

.mcp-event-log-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.mcp-event-log-list::-webkit-scrollbar {
  width: 6px;
}

.mcp-event-log-list::-webkit-scrollbar-track {
  background: transparent;
}

.mcp-event-log-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}

.mcp-event-log-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}

.mcp-event-item {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: background 0.1s ease;
}

.mcp-event-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.mcp-event-item.selected {
  background: rgba(110, 231, 183, 0.1);
}

.mcp-event-item:last-child {
  border-bottom: none;
}

.mcp-event-summary {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.mcp-event-name {
  color: #6ee7b7;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Event state colors */
.mcp-event-item.pending .mcp-event-name {
  color: #fbbf24;
}

.mcp-event-item.fulfilled .mcp-event-name {
  color: #6ee7b7;
}

.mcp-event-item.rejected .mcp-event-name {
  color: #f87171;
}

.mcp-event-label {
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.9em;
  font-weight: 400;
  margin-left: 4px;
}

.mcp-event-time {
  color: rgba(255, 255, 255, 0.3);
  font-size: 10px;
  flex-shrink: 0;
}

.mcp-event-empty {
  padding: 24px;
  text-align: center;
  color: rgba(255, 255, 255, 0.3);
}

.mcp-event-item.replayable .mcp-event-summary {
  position: relative;
}

.mcp-event-item.replayable .mcp-event-name::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 6px;
  margin-left: 2px;
  opacity: 0.5;
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.mcp-event-item.replayable:hover .mcp-event-name::before {
  opacity: 1;
  transform: scale(1.3);
}

/* Detail panel - appears to the left of the event list */
.mcp-detail-panel {
  pointer-events: auto;
  position: absolute;
  bottom: 36px;
  right: 292px;
  width: 400px;
  max-height: 400px;
  background: rgba(24, 24, 24, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  overflow: hidden;
  display: none;
  flex-direction: column;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.mcp-detail-panel.visible {
  display: flex;
}

/* Caret pointing to the event list */
.mcp-detail-panel::after {
  content: '';
  position: absolute;
  right: -8px;
  top: var(--caret-top, 50px);
  width: 0;
  height: 0;
  border-top: 8px solid transparent;
  border-bottom: 8px solid transparent;
  border-left: 8px solid rgba(24, 24, 24, 0.95);
}

.mcp-detail-panel::before {
  content: '';
  position: absolute;
  right: -9px;
  top: var(--caret-top, 50px);
  width: 0;
  height: 0;
  border-top: 9px solid transparent;
  border-bottom: 9px solid transparent;
  border-left: 9px solid rgba(255, 255, 255, 0.1);
  margin-top: -1px;
}

.mcp-detail-header {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mcp-detail-title {
  color: #6ee7b7;
  font-weight: 500;
  font-size: 12px;
}

.mcp-detail-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 14px;
  line-height: 1;
}

.mcp-detail-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
}

.mcp-detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.mcp-detail-content::-webkit-scrollbar {
  width: 6px;
}

.mcp-detail-content::-webkit-scrollbar-track {
  background: transparent;
}

.mcp-detail-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}

.mcp-detail-section {
  margin-bottom: 16px;
}

.mcp-detail-section:last-child {
  margin-bottom: 0;
}

.mcp-detail-section-title {
  color: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.mcp-detail-section pre {
  margin: 0;
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.mcp-detail-section img {
  max-width: 100%;
  border-radius: 4px;
  background-color: #1a1a1a;
  background-image:
    linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
    linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
}

.mcp-detail-meta {
  display: flex;
  gap: 16px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  margin-bottom: 12px;
}

.mcp-detail-meta-item {
  display: flex;
  gap: 4px;
}

.mcp-detail-meta-label {
  color: rgba(255, 255, 255, 0.3);
}

.mcp-detail-status {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  text-transform: uppercase;
}

.mcp-detail-status.success {
  background: rgba(110, 231, 183, 0.2);
  color: #6ee7b7;
}

.mcp-detail-status.error {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}

.mcp-detail-status.pending {
  background: rgba(251, 191, 36, 0.2);
  color: #fbbf24;
}

`;
  function formatTime(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  function formatArgs(args, excludeKeys = ["requestId", "timestamp", "sessionId", "type", "label"]) {
    try {
      const cleaned = { ...args };
      excludeKeys.forEach((key) => delete cleaned[key]);
      if (Object.keys(cleaned).length === 0) {
        return null;
      }
      return JSON.stringify(cleaned, null, 2);
    } catch (e) {
      return String(args);
    }
  }
  function getAbsoluteCoords(selector, x = 0, y = 0) {
    let clientX = x;
    let clientY = y;
    if (selector) {
      const el = document.querySelector(selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        clientX = rect.left + x;
        clientY = rect.top + y;
      }
    }
    return { clientX, clientY };
  }
  function replayMouseEvent(event) {
    const args = event.args;
    const resp = event.response;
    switch (event.name) {
      case "MouseClick": {
        const clientX = resp?.clientX ?? getAbsoluteCoords(args.selector, args.x, args.y).clientX;
        const clientY = resp?.clientY ?? getAbsoluteCoords(args.selector, args.x, args.y).clientY;
        showClick(clientX, clientY);
        break;
      }
      case "MouseHover": {
        const clientX = resp?.clientX ?? getAbsoluteCoords(args.selector, args.x, args.y).clientX;
        const clientY = resp?.clientY ?? getAbsoluteCoords(args.selector, args.x, args.y).clientY;
        showHover(clientX, clientY);
        break;
      }
      case "MouseDrag": {
        const startX = resp?.startClientX ?? getAbsoluteCoords(args.selector, args.startX, args.startY).clientX;
        const startY = resp?.startClientY ?? getAbsoluteCoords(args.selector, args.startX, args.startY).clientY;
        const endX = resp?.endClientX ?? getAbsoluteCoords(args.selector, args.endX, args.endY).clientX;
        const endY = resp?.endClientY ?? getAbsoluteCoords(args.selector, args.endX, args.endY).clientY;
        showDrag(startX, startY, endX, endY);
        break;
      }
      case "MouseWheel": {
        const clientX = resp?.clientX ?? getAbsoluteCoords(args.selector, args.x, args.y).clientX;
        const clientY = resp?.clientY ?? getAbsoluteCoords(args.selector, args.x, args.y).clientY;
        showWheel(clientX, clientY, args.deltaY || 0);
        break;
      }
    }
  }
  function createToast(eventName, label) {
    const toast = document.createElement("div");
    toast.className = "mcp-toast";
    if (label) {
      toast.innerHTML = `${eventName}<span class="mcp-toast-label">(${label})</span>`;
    } else {
      toast.textContent = eventName;
    }
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("fading");
      setTimeout(() => toast.remove(), 300);
    }, TOAST_DURATION);
  }
  function renderDetailPanel(event, itemElement) {
    if (!detailPanel || !event) {
      if (detailPanel) {
        detailPanel.classList.remove("visible");
      }
      return;
    }
    const listRect = historyPanel.querySelector(".mcp-event-log-list").getBoundingClientRect();
    const itemRect = itemElement.getBoundingClientRect();
    const caretTop = itemRect.top - listRect.top + historyPanel.querySelector(".mcp-event-log-header").offsetHeight + 16;
    detailPanel.style.setProperty("--caret-top", `${Math.max(20, Math.min(caretTop, 360))}px`);
    const titleEl = detailPanel.querySelector(".mcp-detail-title");
    const contentEl = detailPanel.querySelector(".mcp-detail-content");
    const labelHtml = event.label ? ` <span class="mcp-event-label">(${event.label})</span>` : "";
    titleEl.innerHTML = `${event.name}${labelHtml}`;
    let html = "";
    html += `<div class="mcp-detail-meta">`;
    html += `<div class="mcp-detail-meta-item"><span class="mcp-detail-meta-label">Time:</span> ${formatTime(event.timestamp)}</div>`;
    if (event.response) {
      const status = event.response.success ? "success" : "error";
      html += `<div class="mcp-detail-meta-item"><span class="mcp-detail-status ${status}">${status}</span></div>`;
    } else {
      html += `<div class="mcp-detail-meta-item"><span class="mcp-detail-status pending">pending</span></div>`;
    }
    html += `</div>`;
    const argsStr = formatArgs(event.args);
    if (argsStr) {
      html += `<div class="mcp-detail-section">`;
      html += `<div class="mcp-detail-section-title">Request</div>`;
      html += `<pre>${escapeHtml(argsStr)}</pre>`;
      html += `</div>`;
    }
    if (event.response) {
      html += `<div class="mcp-detail-section">`;
      html += `<div class="mcp-detail-section-title">Response</div>`;
      const resp = event.response;
      if (resp.imageData) {
        const src = resp.imageData.startsWith("data:") ? resp.imageData : `data:image/png;base64,${resp.imageData}`;
        html += `<img src="${src}" alt="Response image" />`;
      }
      const responseStr = formatArgs(resp, ["requestId", "timestamp", "sessionId", "type", "imageData"]);
      if (responseStr) {
        html += `<pre>${escapeHtml(responseStr)}</pre>`;
      }
      html += `</div>`;
    }
    contentEl.innerHTML = html;
    detailPanel.classList.add("visible");
  }
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
  function closeDetailPanel() {
    if (detailPanel) {
      detailPanel.classList.remove("visible");
    }
    selectedEventIndex = null;
    historyPanel?.querySelectorAll(".mcp-event-item.selected").forEach((el) => {
      el.classList.remove("selected");
    });
  }
  function renderHistory() {
    if (!historyPanel) return;
    const list = historyPanel.querySelector(".mcp-event-log-list");
    if (!list) return;
    if (events.length === 0) {
      list.innerHTML = '<div class="mcp-event-empty">No events yet</div>';
      closeDetailPanel();
      return;
    }
    list.innerHTML = events.map((event, index) => {
      const isMouseReplayable = MOUSE_EVENTS.includes(event.name);
      const isElementReplayable = ELEMENT_EVENTS.includes(event.name);
      const isReplayable = isMouseReplayable || isElementReplayable;
      const isSelected = selectedEventIndex === index;
      const labelHtml = event.label ? `<span class="mcp-event-label">(${event.label})</span>` : "";
      let stateClass = "pending";
      if (event.response) {
        stateClass = event.response.success ? "fulfilled" : "rejected";
      }
      return `
      <div class="mcp-event-item${isReplayable ? " replayable" : ""}${isSelected ? " selected" : ""} ${stateClass}" data-index="${index}">
        <div class="mcp-event-summary">
          <span class="mcp-event-name">${event.name}${labelHtml}</span>
          <span class="mcp-event-time">${formatTime(event.timestamp)}</span>
        </div>
      </div>
    `;
    }).join("");
    list.querySelectorAll(".mcp-event-item").forEach((item) => {
      const index = parseInt(item.dataset.index, 10);
      const event = events[index];
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectedEventIndex === index) {
          closeDetailPanel();
        } else {
          list.querySelectorAll(".mcp-event-item.selected").forEach((el) => {
            el.classList.remove("selected");
          });
          item.classList.add("selected");
          selectedEventIndex = index;
          renderDetailPanel(event, item);
        }
      });
      if (MOUSE_EVENTS.includes(event.name)) {
        item.addEventListener("mouseenter", () => {
          replayMouseEvent(event);
        });
      }
      if (ELEMENT_EVENTS.includes(event.name)) {
        item.addEventListener("mouseenter", () => {
          const selector = event.args?.selector;
          if (selector) {
            showElementHighlight(selector);
          }
        });
        item.addEventListener("mouseleave", () => {
          hideElementHighlight();
        });
      }
    });
    if (selectedEventIndex !== null && selectedEventIndex < events.length) {
      const selectedItem = list.querySelector(`[data-index="${selectedEventIndex}"]`);
      if (selectedItem) {
        renderDetailPanel(events[selectedEventIndex], selectedItem);
      }
    }
  }
  function toggleExpanded() {
    expanded = !expanded;
    toggleButton.classList.toggle("expanded", expanded);
    historyPanel.classList.toggle("visible", expanded);
    toastContainer.style.display = expanded ? "none" : "flex";
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? "1" : "0");
    } catch (e) {
    }
    if (expanded) {
      renderHistory();
    } else {
      closeDetailPanel();
    }
  }
  function clearHistory() {
    events = [];
    eventsByRequestId.clear();
    closeDetailPanel();
    renderHistory();
  }
  function init2() {
    if (container) return;
    try {
      expanded = localStorage.getItem(EXPANDED_STORAGE_KEY) === "1";
    } catch (e) {
    }
    const styleEl2 = document.createElement("style");
    styleEl2.textContent = styles2;
    document.head.appendChild(styleEl2);
    container = document.createElement("div");
    container.className = "mcp-event-log";
    toastContainer = document.createElement("div");
    toastContainer.className = "mcp-event-log-toasts";
    container.appendChild(toastContainer);
    detailPanel = document.createElement("div");
    detailPanel.className = "mcp-detail-panel";
    detailPanel.innerHTML = `
    <div class="mcp-detail-header">
      <span class="mcp-detail-title"></span>
      <button class="mcp-detail-close">&times;</button>
    </div>
    <div class="mcp-detail-content"></div>
  `;
    container.appendChild(detailPanel);
    detailPanel.querySelector(".mcp-detail-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeDetailPanel();
    });
    historyPanel = document.createElement("div");
    historyPanel.className = "mcp-event-log-history";
    historyPanel.innerHTML = `
    <div class="mcp-event-log-header">
      <span>MCP Events</span>
      <button class="mcp-event-log-clear">Clear</button>
    </div>
    <div class="mcp-event-log-list"></div>
  `;
    container.appendChild(historyPanel);
    toggleButton = document.createElement("button");
    toggleButton.className = "mcp-event-log-toggle";
    toggleButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    toggleButton.addEventListener("click", toggleExpanded);
    container.appendChild(toggleButton);
    historyPanel.querySelector(".mcp-event-log-clear").addEventListener("click", (e) => {
      e.stopPropagation();
      clearHistory();
    });
    document.addEventListener("click", (e) => {
      if (!expanded) return;
      if (!container.contains(e.target)) {
        toggleExpanded();
      }
    });
    document.body.appendChild(container);
    if (expanded) {
      toggleButton.classList.add("expanded");
      historyPanel.classList.add("visible");
      toastContainer.style.display = "none";
      renderHistory();
    }
  }
  function logEvent(eventName, args = {}) {
    init2();
    const label = args.label;
    const requestId = args.requestId;
    const event = {
      name: eventName,
      args,
      label,
      requestId,
      timestamp: Date.now(),
      response: null
    };
    events.unshift(event);
    if (requestId) {
      eventsByRequestId.set(requestId, event);
    }
    if (events.length > MAX_EVENTS) {
      const removed = events.splice(MAX_EVENTS);
      removed.forEach((e) => {
        if (e.requestId) {
          eventsByRequestId.delete(e.requestId);
        }
      });
    }
    if (!expanded) {
      createToast(eventName, label);
    } else {
      renderHistory();
    }
  }
  function logResponse(requestId, response) {
    const event = eventsByRequestId.get(requestId);
    if (event) {
      event.response = response;
      if (expanded) {
        renderHistory();
      }
    }
  }
  function getEventLog() {
    return { events, expanded, container, eventsByRequestId };
  }
  if (typeof window !== "undefined") {
    window.__mcpEventLog = { getEventLog, logResponse };
  }

  // src/vite/client/client.js
  var RECONNECT_INTERVAL = 2e3;
  var SESSION_TIMEOUT = 5e3;
  var REFRESH_SESSION_KEY = "__debug_refresh_session";
  var DebugClient = class {
    constructor(config) {
      this.config = config;
      this.ws = null;
      const pendingSession = sessionStorage.getItem(REFRESH_SESSION_KEY);
      if (pendingSession) {
        this.sessionId = pendingSession;
        sessionStorage.removeItem(REFRESH_SESSION_KEY);
      } else {
        this.sessionId = "session-" + Date.now();
      }
      this.connected = false;
      this.connecting = false;
      this.connectAttempts = 0;
      this.messageQueue = [];
      this.originalConsole = {};
      this.errorWatching = null;
      this.sessionStartTime = Date.now();
      this.sessionEnded = false;
      this.injectedVariables = /* @__PURE__ */ new Map();
    }
    init() {
      window.addEventListener("beforeunload", () => {
        if (this.ws) {
          this.ws.onclose = null;
          this.ws.close();
        }
      });
      this.connect();
      this.originalConsole = patchConsole(this.send.bind(this));
      this.errorWatching = setupErrorWatching(this.send.bind(this));
      this.send({
        type: "session_start",
        sessionId: this.sessionId,
        timestamp: Date.now(),
        data: {
          url: window.location.href,
          userAgent: navigator.userAgent
        }
      });
      setTimeout(() => {
        if (!this.sessionEnded) {
          this.endSession();
        }
      }, SESSION_TIMEOUT);
      window.__debugClient = this;
      this.setupViteErrorBridge();
      this.signalReady();
    }
    /**
     * Forward Vite build/parse errors (e.g. syntax errors in notebook cells) to MCP.
     *
     * Two detection mechanisms:
     *  1. Custom DOM event "vite:error" dispatched by runtime-expose.js (which has
     *     access to import.meta.hot and therefore Vite's HMR error events).
     *  2. MutationObserver watching for <vite-error-overlay> being added to the DOM
     *     as a fallback in case the HMR bridge fires before the debug client connects.
     */
    setupViteErrorBridge() {
      const sendViteError = (errorInfo) => {
        this.send({
          type: "vite_error",
          data: errorInfo
        });
        this.endSession();
      };
      window.addEventListener("vite:error", (event) => {
        sendViteError(event.detail);
      });
      if (Array.isArray(window.__viteErrors) && window.__viteErrors.length > 0) {
        for (const err of window.__viteErrors) {
          sendViteError(err);
        }
      }
      if (window.__viteErrorPayload) {
        const err = window.__viteErrorPayload;
        sendViteError({
          message: err?.message || String(err),
          stack: err?.stack || null,
          frame: err?.frame || null,
          loc: err?.loc || null,
          plugin: err?.plugin || null,
          id: err?.id || null,
          source: "vite-error-page"
        });
      }
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.tagName === "VITE-ERROR-OVERLAY") {
              const shadowRoot = node.shadowRoot;
              const messageEl = shadowRoot?.querySelector(".message-body");
              const fileEl = shadowRoot?.querySelector(".file");
              const frameEl = shadowRoot?.querySelector(".frame");
              const message = messageEl?.textContent?.trim() || "Vite build error";
              const file = fileEl?.textContent?.trim() || null;
              const frame = frameEl?.textContent?.trim() || null;
              sendViteError({ message, file, frame, source: "vite-error-overlay" });
              observer.disconnect();
              return;
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    signalReady() {
      const checkReady = () => {
        const runtime = getRuntimeModule();
        if (runtime) {
          this.endSession();
          return true;
        }
        return false;
      };
      if (checkReady()) return;
      let attempts = 0;
      const maxAttempts = 50;
      const interval = setInterval(() => {
        attempts++;
        if (checkReady() || attempts >= maxAttempts) {
          clearInterval(interval);
        }
      }, 100);
    }
    /**
     * Get the notebook path identifier from the current URL
     */
    getNotebookPath() {
      let path = window.location.pathname.replace(/^\//, "") || "index";
      path = path.replace(/\.html$/, "");
      return path;
    }
    connect() {
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const notebookPath = encodeURIComponent(this.getNotebookPath());
      const wsUrl = `${wsProtocol}//${window.location.host}/__debug_ws/${notebookPath}`;
      const MAX_CONNECT_ATTEMPTS = 5;
      if (this.connecting) {
        return;
      }
      this.connectAttempts++;
      if (this.connectAttempts > MAX_CONNECT_ATTEMPTS) {
        console.log("[DebugClient] Max connection attempts reached, giving up");
        return;
      }
      this.connecting = true;
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.onopen = null;
          this.ws.onmessage = null;
          this.ws.close();
        } catch (e) {
        }
        this.ws = null;
      }
      try {
        console.log("[DebugClient] Connecting via Vite proxy:", wsUrl, `(attempt ${this.connectAttempts}/${MAX_CONNECT_ATTEMPTS})`);
        this.ws = new WebSocket(wsUrl);
        const connectionTimeout = setTimeout(() => {
          if (!this.connected && this.connecting) {
            console.log("[DebugClient] Connection timeout, retrying...");
            this.connecting = false;
            try {
              this.ws.close();
            } catch (e) {
            }
            setTimeout(() => this.connect(), 500);
          }
        }, 3e3);
        this.ws.onopen = () => {
          clearTimeout(connectionTimeout);
          this.connecting = false;
          this.connected = true;
          this.connectAttempts = 0;
          console.log("[DebugClient] Connected to MCP server at", wsUrl);
          init2();
          while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            this.ws.send(msg);
          }
        };
        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          const wasConnected = this.connected;
          this.connecting = false;
          this.connected = false;
          if (wasConnected) {
            console.log("[DebugClient] Disconnected from MCP server (code:", event.code, "reason:", event.reason || "none", "), reconnecting in", RECONNECT_INTERVAL, "ms");
            setTimeout(() => this.connect(), RECONNECT_INTERVAL);
          }
        };
        this.ws.onerror = (err) => {
          clearTimeout(connectionTimeout);
          console.error("[DebugClient] WebSocket error:", err);
        };
        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleServerMessage(message);
          } catch (err) {
            console.error("[DebugClient] Failed to parse server message:", err);
          }
        };
      } catch (err) {
        console.error("[DebugClient] Failed to connect:", err);
        setTimeout(() => this.connect(), RECONNECT_INTERVAL);
      }
    }
    handleServerMessage(message) {
      if (message.type === "Refresh") {
        sessionStorage.setItem(REFRESH_SESSION_KEY, message.sessionId);
        window.location.reload();
        return;
      }
      if (message.type === "Navigate") {
        sessionStorage.setItem(REFRESH_SESSION_KEY, message.sessionId);
        window.location.href = message.url;
        return;
      }
      if (message.type) {
        logEvent(message.type, message);
      }
      if (message.type === "GetValue") {
        handleGetValueRequest(this, message);
        return;
      }
      if (message.type === "GetValues") {
        handleGetValuesRequest(this, message);
        return;
      }
      if (message.type === "ListValues") {
        handleListValuesRequest(this, message);
        return;
      }
      if (message.type === "GetValueMetadata") {
        handleGetValueMetadataRequest(this, message);
        return;
      }
      if (message.type === "GetCellValue") {
        handleGetValueRequest(this, { ...message, name: message.cellName });
        return;
      }
      if (message.type === "ListCells") {
        handleListValuesRequest(this, message);
        return;
      }
      if (message.type === "GetErrors") {
        handleGetErrorsRequest(this, message);
        return;
      }
      if (message.type === "SetInput") {
        handleSetInputRequest(this, message);
        return;
      }
      if (message.type === "GetElementContent") {
        handleGetElementContentRequest(this, message);
        return;
      }
      if (message.type === "GetDependencyGraph") {
        handleGetDependencyGraphRequest(this, message);
        return;
      }
      if (message.type === "BrowserEval") {
        handleBrowserEvalRequest(this, message);
        return;
      }
      if (message.type === "MouseClick") {
        handleMouseClickRequest(this, message);
        return;
      }
      if (message.type === "MouseDrag") {
        handleMouseDragRequest(this, message);
        return;
      }
      if (message.type === "MouseWheel") {
        handleMouseWheelRequest(this, message);
        return;
      }
      if (message.type === "MouseHover") {
        handleMouseHoverRequest(this, message);
        return;
      }
      if (message.type === "SendKeys") {
        handleSendKeysRequest(this, message);
        return;
      }
      if (message.type === "RuntimeEval") {
        handleRuntimeEvalRequest(this, message);
        return;
      }
    }
    send(message) {
      const data = JSON.stringify({
        ...message,
        sessionId: this.sessionId,
        timestamp: message.timestamp || Date.now()
      });
      if (message.requestId && message.type?.endsWith("_response")) {
        logResponse(message.requestId, message);
      }
      if (this.connected && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(data);
      } else {
        this.messageQueue.push(data);
      }
    }
    endSession() {
      if (this.sessionEnded) return;
      this.sessionEnded = true;
      this.send({
        type: "session_end",
        data: { duration: Date.now() - this.sessionStartTime }
      });
      if (this.errorWatching) {
        if (this.errorWatching.interval) clearInterval(this.errorWatching.interval);
        if (this.errorWatching.observer) this.errorWatching.observer.disconnect();
      }
    }
  };

  // src/vite/client/index.js
  (function() {
    const config = window.__NOTEBOOKKIT_DEBUG_CONFIG__ || { ws: 9899 };
    let client = null;
    function initDebugClient() {
      if (client) {
        try {
          if (client.ws) {
            client.ws.onclose = null;
            client.ws.close();
          }
        } catch (e) {
        }
      }
      client = new DebugClient(config);
      client.init();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initDebugClient);
    } else {
      initDebugClient();
    }
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        initDebugClient();
      }
    });
  })();
})();
//# sourceMappingURL=debug-client.js.map
