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
    const errors = [];
    const errorSelectors = [
      ".observablehq--error",
      ".notebook-error",
      "[data-error]",
      ".error"
    ];
    for (const selector of errorSelectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const cellElement = el.closest('[id^="cell-"]') || el.closest("script") || el.parentElement;
        const cellId = cellElement?.id || "unknown";
        const errorText = el.textContent?.trim() || el.getAttribute("data-error") || "Unknown error";
        if (!errors.some((e) => e.cell === cellId && e.error === errorText)) {
          errors.push({
            cell: cellId,
            error: errorText,
            source: "dom"
          });
        }
      });
    }
    const runtime = getRuntimeModule();
    if (runtime && runtime._scope) {
      const names = Array.from(runtime._scope.keys()).filter(
        (name) => !name.startsWith("_")
      );
      for (const name of names) {
        const result = await getValueState(runtime, name, 100);
        if (result.state === "rejected") {
          if (!errors.some((e) => e.cell === name)) {
            errors.push({
              cell: name,
              name,
              error: result.error,
              stack: result.stack,
              source: "runtime"
            });
          }
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
    const { selector, mode = "auto" } = message;
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
      const isImage = element instanceof HTMLImageElement;
      const shouldCaptureImage = mode === "image" || mode === "auto" && (isCanvas || isSVG);
      const shouldGetText = mode === "text" || mode === "auto" && !isCanvas && !isSVG;
      const shouldGetHTML = mode === "html";
      if (isCanvas) response.elementType = "canvas";
      else if (isSVG) response.elementType = "svg";
      else if (isImage) response.elementType = "image";
      else response.elementType = "element";
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
      if (isSVG && mode !== "image") {
        response.svgSource = element.outerHTML;
      }
      if (shouldGetText || mode === "auto") {
        response.textContent = element.textContent?.trim() || "";
      }
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
  async function handleEvalRequest(client, message) {
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
        type: "eval_response",
        requestId: message.requestId,
        success: true,
        result: await serializeValueAsync(result)
      });
    } catch (error) {
      client.send({
        type: "eval_response",
        requestId: message.requestId,
        success: true,
        // Request succeeded, but code threw an error
        error: error.message,
        stack: error.stack
      });
    }
  }

  // src/vite/client/handlers/variables.js
  async function handleDefineVariableRequest(client, message) {
    const { name, inputs, expression } = message;
    const runtime = getRuntimeModule();
    if (!runtime) {
      client.send({
        type: "define_response",
        requestId: message.requestId,
        name,
        success: false,
        error: "Observable runtime not found"
      });
      return;
    }
    try {
      let deps = inputs;
      if (!deps) {
        deps = detectDependencies(runtime, expression);
      }
      const AsyncFunction = Object.getPrototypeOf(async function() {
      }).constructor;
      const fn = new AsyncFunction(...deps, `return (${expression})`);
      if (runtime._scope && runtime._scope.has(name) && !client.injectedVariables.has(name)) {
        client.send({
          type: "define_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `Cannot define "${name}": a variable with this name already exists in the notebook`
        });
        return;
      }
      if (client.injectedVariables.has(name)) {
        client.injectedVariables.get(name).delete();
        client.injectedVariables.delete(name);
      }
      const variable = runtime.define(name, deps, fn);
      client.injectedVariables.set(name, variable);
      const result = await getValueState(runtime, name, message.timeout || 5e3);
      if (result.state === "fulfilled") {
        client.send({
          type: "define_response",
          requestId: message.requestId,
          name,
          success: true,
          state: "fulfilled",
          value: await serializeValueAsync(result.value),
          inputs: deps
        });
      } else if (result.state === "pending") {
        client.send({
          type: "define_response",
          requestId: message.requestId,
          name,
          success: true,
          state: "pending",
          inputs: deps
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
          inputs: deps
        });
      }
    } catch (error) {
      client.send({
        type: "define_response",
        requestId: message.requestId,
        name,
        success: false,
        error: error.message,
        stack: error.stack
      });
    }
  }
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
  async function handleDeleteVariableRequest(client, message) {
    const { name } = message;
    if (!client.injectedVariables.has(name)) {
      client.send({
        type: "delete_response",
        requestId: message.requestId,
        name,
        success: false,
        error: `No injected variable named "${name}" found`
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
        success: true
      });
    } catch (error) {
      client.send({
        type: "delete_response",
        requestId: message.requestId,
        name,
        success: false,
        error: error.message
      });
    }
  }
  function handleListInjectedVariablesRequest(client, message) {
    const names = Array.from(client.injectedVariables.keys());
    client.send({
      type: "injected_list_response",
      requestId: message.requestId,
      success: true,
      variables: names
    });
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
      target.dispatchEvent(new MouseEvent("mousedown", eventInit));
      const startTime = performance.now();
      let moveCount = 0;
      const animate = () => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        const currentX = startClientX + (endClientX - startClientX) * t;
        const currentY = startClientY + (endClientY - startClientY) * t;
        window.dispatchEvent(
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
          window.dispatchEvent(
            new MouseEvent("mouseup", {
              ...eventInit,
              clientX: endClientX,
              clientY: endClientY,
              screenX: endClientX,
              screenY: endClientY
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
      this.messageQueue = [];
      this.originalConsole = {};
      this.errorWatching = null;
      this.sessionStartTime = Date.now();
      this.sessionEnded = false;
      this.injectedVariables = /* @__PURE__ */ new Map();
    }
    init() {
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
      this.signalReady();
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
    connect() {
      const wsUrl = `ws://localhost:${this.config.ws}`;
      try {
        this.ws = new WebSocket(wsUrl);
        this.ws.onopen = () => {
          this.connected = true;
          console.log("[DebugClient] Connected to MCP server at", wsUrl);
          while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            this.ws.send(msg);
          }
        };
        this.ws.onclose = () => {
          this.connected = false;
          console.log("[DebugClient] Disconnected from MCP server, reconnecting in", RECONNECT_INTERVAL, "ms");
          setTimeout(() => this.connect(), RECONNECT_INTERVAL);
        };
        this.ws.onerror = (err) => {
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
      if (message.type === "Eval") {
        handleEvalRequest(this, message);
        return;
      }
      if (message.type === "DefineVariable") {
        handleDefineVariableRequest(this, message);
        return;
      }
      if (message.type === "DeleteVariable") {
        handleDeleteVariableRequest(this, message);
        return;
      }
      if (message.type === "ListInjectedVariables") {
        handleListInjectedVariablesRequest(this, message);
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
      if (message.type === "SendKeys") {
        handleSendKeysRequest(this, message);
        return;
      }
    }
    send(message) {
      const data = JSON.stringify({
        ...message,
        sessionId: this.sessionId,
        timestamp: message.timestamp || Date.now()
      });
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
    if (window.location.hostname !== "localhost" && !window.location.hostname.match(/127\.0\.0\.1/)) {
      return;
    }
    const config = window.__NOTEBOOKKIT_DEBUG_CONFIG__ || { ws: 9899 };
    console.log("[DebugClient] Config:", window.__NOTEBOOKKIT_DEBUG_CONFIG__, "-> Using port", config.ws);
    function initDebugClient() {
      const client = new DebugClient(config);
      client.init();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initDebugClient);
    } else {
      initDebugClient();
    }
  })();
})();
//# sourceMappingURL=debug-client.js.map
