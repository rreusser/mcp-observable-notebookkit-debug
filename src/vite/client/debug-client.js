(function () {
  if (
    window.location.hostname !== "localhost" &&
    !window.location.hostname.match(/127\.0\.0\.1/)
  )
    return;

  // Get port from injected config, fallback to default
  const config = window.__NOTEBOOKKIT_DEBUG_CONFIG__ || { ws: 9899 };
  const DEBUG_WS_URL = `ws://localhost:${config.ws}`;
  console.log("[DebugClient] Config:", window.__NOTEBOOKKIT_DEBUG_CONFIG__, "-> Using port", config.ws);
  const RECONNECT_INTERVAL = 2000;
  const ERROR_CHECK_INTERVAL = 500;
  const SESSION_TIMEOUT = 5000;
  const REFRESH_SESSION_KEY = "__debug_refresh_session";

  class DebugClient {
    constructor() {
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
      this.errorObserver = null;
      this.sessionStartTime = Date.now();
      this.sessionEnded = false;
      // Track injected ephemeral variables for cleanup
      this.injectedVariables = new Map();
    }

    init() {
      this.connect();
      this.patchConsole();
      this.watchForErrors();
      this.watchForRuntimeErrors();

      this.send({
        type: "session_start",
        sessionId: this.sessionId,
        timestamp: Date.now(),
        data: {
          url: window.location.href,
          userAgent: navigator.userAgent,
        },
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
        const runtime = this.getRuntimeModule();
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
      try {
        this.ws = new WebSocket(DEBUG_WS_URL);

        this.ws.onopen = () => {
          this.connected = true;
          console.log("[DebugClient] Connected to MCP server at", DEBUG_WS_URL);

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

      // Value-centric handlers (new)
      if (message.type === "GetValue") {
        this.handleGetValueRequest(message);
        return;
      }

      if (message.type === "GetValues") {
        this.handleGetValuesRequest(message);
        return;
      }

      if (message.type === "ListValues") {
        this.handleListValuesRequest(message);
        return;
      }

      if (message.type === "GetValueMetadata") {
        this.handleGetValueMetadataRequest(message);
        return;
      }

      // Legacy handlers (for backwards compatibility during transition)
      if (message.type === "GetCellValue") {
        this.handleGetValueRequest({ ...message, name: message.cellName });
        return;
      }

      if (message.type === "ListCells") {
        this.handleListValuesRequest(message);
        return;
      }

      if (message.type === "GetErrors") {
        this.handleGetErrorsRequest(message);
        return;
      }

      if (message.type === "SetInput") {
        this.handleSetInputRequest(message);
        return;
      }

      if (message.type === "GetElementContent") {
        this.handleGetElementContentRequest(message);
        return;
      }

      if (message.type === "GetDependencyGraph") {
        this.handleGetDependencyGraphRequest(message);
        return;
      }

      if (message.type === "Eval") {
        this.handleEvalRequest(message);
        return;
      }

      if (message.type === "DefineVariable") {
        this.handleDefineVariableRequest(message);
        return;
      }

      if (message.type === "DeleteVariable") {
        this.handleDeleteVariableRequest(message);
        return;
      }

      if (message.type === "ListInjectedVariables") {
        this.handleListInjectedVariablesRequest(message);
        return;
      }

      if (message.type === "MouseClick") {
        this.handleMouseClickRequest(message);
        return;
      }

      if (message.type === "MouseDrag") {
        this.handleMouseDragRequest(message);
        return;
      }

      if (message.type === "MouseWheel") {
        this.handleMouseWheelRequest(message);
        return;
      }
    }

    getRuntimeModule() {
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
    getVariable(runtime, name) {
      return runtime._scope?.get(name) || null;
    }

    /**
     * Determine the state of a variable: pending, fulfilled, or rejected
     * Returns { state, value?, error? }
     */
    async getValueState(runtime, name, timeout = 100) {
      const variable = this.getVariable(runtime, name);

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
    getVariableMetadata(runtime, name) {
      const variable = this.getVariable(runtime, name);

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
     * Handle GetValue request - returns value with state info
     * Automatically captures SVG elements as images
     */
    async handleGetValueRequest(message) {
      const runtime = this.getRuntimeModule();
      const name = message.name || message.cellName;

      if (!runtime) {
        this.send({
          type: "value_response",
          requestId: message.requestId,
          name,
          success: false,
          error: "Observable runtime not found",
        });
        return;
      }

      const result = await this.getValueState(runtime, name, message.timeout || 5000);

      if (result.state === "fulfilled") {
        let serializedValue = result.value;

        // Check if the value is an SVG element and capture it as an image
        if (result.value instanceof SVGElement ||
            (result.value instanceof Element && result.value.tagName?.toLowerCase() === 'svg')) {
          try {
            const imageData = await this.captureSVGAsImage(result.value);
            if (imageData) {
              serializedValue = {
                __type: "SVG",
                width: imageData.width,
                height: imageData.height,
                data: imageData.data,
              };
            } else {
              serializedValue = this.serializeValue(result.value);
            }
          } catch (err) {
            // Fall back to regular serialization if capture fails
            serializedValue = this.serializeValue(result.value);
          }
        } else {
          serializedValue = this.serializeValue(result.value);
        }

        this.send({
          type: "value_response",
          requestId: message.requestId,
          name,
          success: true,
          state: "fulfilled",
          value: serializedValue,
        });
      } else if (result.state === "pending") {
        this.send({
          type: "value_response",
          requestId: message.requestId,
          name,
          success: true,
          state: "pending",
        });
      } else {
        this.send({
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
    async handleGetValuesRequest(message) {
      const runtime = this.getRuntimeModule();

      if (!runtime || !runtime._scope) {
        this.send({
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
        const result = await this.getValueState(runtime, name, timeout);

        if (result.state === "fulfilled") {
          values[name] = {
            state: "fulfilled",
            value: this.serializeValue(result.value),
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

      this.send({
        type: "values_response",
        requestId: message.requestId,
        success: true,
        values,
      });
    }

    /**
     * Handle ListValues request - returns list of all value names
     */
    handleListValuesRequest(message) {
      const runtime = this.getRuntimeModule();

      if (!runtime || !runtime._scope) {
        this.send({
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

      this.send({
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
    async handleGetValueMetadataRequest(message) {
      const runtime = this.getRuntimeModule();
      const name = message.name;

      if (!runtime || !runtime._scope) {
        this.send({
          type: "metadata_response",
          requestId: message.requestId,
          name,
          success: false,
          error: "Observable runtime not found",
        });
        return;
      }

      const metadata = this.getVariableMetadata(runtime, name);

      if (!metadata) {
        this.send({
          type: "metadata_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `${name} is not defined`,
        });
        return;
      }

      // Get state without waiting long for pending values
      const stateResult = await this.getValueState(runtime, name, 50);

      // Get value type hint without full serialization
      let valueType = null;
      if (stateResult.state === "fulfilled" && stateResult.value !== undefined) {
        valueType = this.getValueTypeHint(stateResult.value);
      }

      this.send({
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

    /**
     * Get a type hint for a value without full serialization
     */
    getValueTypeHint(value) {
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

    async handleGetErrorsRequest(message) {
      const errors = [];

      const errorSelectors = [
        ".observablehq--error",
        ".notebook-error",
        "[data-error]",
        ".error",
      ];

      for (const selector of errorSelectors) {
        document.querySelectorAll(selector).forEach((el) => {
          const cellElement =
            el.closest('[id^="cell-"]') ||
            el.closest("script") ||
            el.parentElement;
          const cellId = cellElement?.id || "unknown";
          const errorText =
            el.textContent?.trim() ||
            el.getAttribute("data-error") ||
            "Unknown error";

          if (!errors.some((e) => e.cell === cellId && e.error === errorText)) {
            errors.push({
              cell: cellId,
              error: errorText,
              source: "dom",
            });
          }
        });
      }

      const runtime = this.getRuntimeModule();
      if (runtime && runtime._scope) {
        const names = Array.from(runtime._scope.keys()).filter(
          (name) => !name.startsWith("_")
        );

        for (const name of names) {
          const result = await this.getValueState(runtime, name, 100);
          if (result.state === "rejected") {
            if (!errors.some((e) => e.cell === name)) {
              errors.push({
                cell: name,
                name: name,
                error: result.error,
                stack: result.stack,
                source: "runtime",
              });
            }
          }
        }
      }

      this.send({
        type: "errors_response",
        requestId: message.requestId,
        success: true,
        errors,
      });
    }

    /**
     * Handle SetInput request - sets the value of an input element and triggers reactive updates
     */
    async handleSetInputRequest(message) {
      const runtime = this.getRuntimeModule();
      const name = message.name;
      const newValue = message.value;

      if (!runtime) {
        this.send({
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
        const variable = this.getVariable(runtime, name);
        if (!variable) {
          this.send({
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
          this.send({
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
          this.send({
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
          this.send({
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
            this.send({
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
            this.send({
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

        this.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: true,
          previousValue,
          newValue: resultValue,
        });
      } catch (error) {
        this.send({
          type: "setinput_response",
          requestId: message.requestId,
          name,
          success: false,
          error: error.message,
        });
      }
    }

    /**
     * Handle GetElementContent request - gets content from DOM elements
     * Supports text, HTML, canvas capture, and SVG
     */
    async handleGetElementContentRequest(message) {
      const { selector, mode = 'auto' } = message;

      try {
        const element = document.querySelector(selector);

        if (!element) {
          this.send({
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
            const imageData = await this.captureElementAsImage(element);
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

        this.send(response);
      } catch (error) {
        this.send({
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
    async captureElementAsImage(element) {
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
        return await this.captureSVGAsImage(element);
      }

      // For other elements, we'd need html2canvas or similar
      // For now, return null and let the text content be used
      return null;
    }

    /**
     * Capture SVG element as PNG image
     */
    async captureSVGAsImage(svgElement) {
      return new Promise((resolve, reject) => {
        try {
          // Clone the SVG to avoid modifying the original
          const clone = svgElement.cloneNode(true);

          // Get dimensions
          const bbox = svgElement.getBoundingClientRect();
          const width = bbox.width || svgElement.getAttribute('width') || 300;
          const height = bbox.height || svgElement.getAttribute('height') || 150;

          // Ensure the clone has dimensions
          clone.setAttribute('width', width);
          clone.setAttribute('height', height);

          // Serialize SVG to string
          const serializer = new XMLSerializer();
          const svgString = serializer.serializeToString(clone);

          // Create a blob and URL
          const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);

          // Create an image and draw to canvas
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);

            resolve({
              data: canvas.toDataURL('image/png').split(',')[1],
              width: width,
              height: height,
            });
          };
          img.onerror = (err) => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load SVG as image'));
          };
          img.src = url;
        } catch (err) {
          reject(err);
        }
      });
    }

    /**
     * Handle GetDependencyGraph request - returns the dependency graph with optional filtering
     */
    async handleGetDependencyGraphRequest(message) {
      const runtime = this.getRuntimeModule();
      const filters = message.filters || {};

      if (!runtime || !runtime._scope) {
        this.send({
          type: "dependencygraph_response",
          requestId: message.requestId,
          success: false,
          error: "Observable runtime not found",
        });
        return;
      }

      try {
        const allNodes = [];
        const allEdges = [];
        const scope = runtime._scope;
        const nodeMap = new Map();

        // Helper to check if name is an anonymous value (e.g., "cell 1", "cell 2")
        const isAnonymousValue = (name) => /^cell \d+$/.test(name);

        // Helper to match pattern with wildcard support
        const matchesPattern = (name, pattern) => {
          if (!pattern) return true;
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
          return regex.test(name);
        };

        // First pass: collect all nodes and build node map
        for (const [name, variable] of scope.entries()) {
          // Skip internal variables
          if (name.startsWith('_')) continue;

          // Get state for this variable
          const stateResult = await this.getValueState(runtime, name, 50);

          // Get type hint if fulfilled
          let valueType = null;
          if (stateResult.state === 'fulfilled' && stateResult.value !== undefined) {
            valueType = this.getValueTypeHint(stateResult.value);
          }

          // Get inputs (dependencies)
          const inputs = variable._inputs
            ? variable._inputs
                .map(v => v._name)
                .filter(n => n && !n.startsWith('_'))
            : [];

          // Get outputs (dependents)
          const outputs = variable._outputs
            ? Array.from(variable._outputs)
                .map(v => v._name)
                .filter(n => n && !n.startsWith('_'))
            : [];

          const node = {
            name,
            state: stateResult.state,
            valueType,
            inputs,
            outputs,
          };

          allNodes.push(node);
          nodeMap.set(name, node);

          // Create edges for dependencies
          for (const input of inputs) {
            allEdges.push({
              from: input,
              to: name,
            });
          }
        }

        // Apply filters
        let filteredNodeNames = new Set();

        if (filters.name) {
          // Focus on specific node - traverse dependencies/dependents
          const focusNode = nodeMap.get(filters.name);
          if (!focusNode) {
            this.send({
              type: "dependencygraph_response",
              requestId: message.requestId,
              success: false,
              error: `Node "${filters.name}" not found`,
            });
            return;
          }

          filteredNodeNames.add(filters.name);
          const maxDepth = filters.depth >= 0 ? filters.depth : Infinity;

          // Traverse upstream (dependencies)
          if (filters.direction === 'both' || filters.direction === 'upstream') {
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

          // Traverse downstream (dependents)
          if (filters.direction === 'both' || filters.direction === 'downstream') {
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
          // Filter by pattern
          for (const node of allNodes) {
            if (matchesPattern(node.name, filters.pattern)) {
              filteredNodeNames.add(node.name);
            }
          }
        } else {
          // No name/pattern filter - include all
          for (const node of allNodes) {
            filteredNodeNames.add(node.name);
          }
        }

        // Apply include_anonymous filter
        if (!filters.include_anonymous) {
          filteredNodeNames = new Set(
            [...filteredNodeNames].filter(name => !isAnonymousValue(name))
          );
        }

        // Filter nodes and edges
        const nodes = allNodes.filter(n => filteredNodeNames.has(n.name));
        const edges = allEdges.filter(e =>
          filteredNodeNames.has(e.from) && filteredNodeNames.has(e.to)
        );

        // Update inputs/outputs to only include filtered nodes
        for (const node of nodes) {
          node.inputs = node.inputs.filter(n => filteredNodeNames.has(n));
          node.outputs = node.outputs.filter(n => filteredNodeNames.has(n));
        }

        // Sort nodes: roots first, then by name
        nodes.sort((a, b) => {
          const aIsRoot = a.inputs.length === 0;
          const bIsRoot = b.inputs.length === 0;
          if (aIsRoot && !bIsRoot) return -1;
          if (!aIsRoot && bIsRoot) return 1;
          return a.name.localeCompare(b.name);
        });

        this.send({
          type: "dependencygraph_response",
          requestId: message.requestId,
          success: true,
          graph: { nodes, edges },
        });
      } catch (error) {
        this.send({
          type: "dependencygraph_response",
          requestId: message.requestId,
          success: false,
          error: error.message,
        });
      }
    }

    /**
     * Handle Eval request - execute arbitrary JavaScript code and return the result
     */
    async handleEvalRequest(message) {
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

        this.send({
          type: "eval_response",
          requestId: message.requestId,
          success: true,
          result: this.serializeValue(result),
        });
      } catch (error) {
        this.send({
          type: "eval_response",
          requestId: message.requestId,
          success: true, // Request succeeded, but code threw an error
          error: error.message,
          stack: error.stack,
        });
      }
    }

    /**
     * Handle DefineVariable request - inject an ephemeral variable into the Observable runtime
     * The variable participates in the reactive graph and can depend on existing variables.
     *
     * Accepts either:
     * - { name, inputs, expression } - explicit dependencies and expression string
     * - { name, expression } - auto-detect dependencies from expression
     */
    async handleDefineVariableRequest(message) {
      const { name, inputs, expression } = message;
      const runtime = this.getRuntimeModule();

      if (!runtime) {
        this.send({
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
          deps = this.detectDependencies(runtime, expression);
        }

        // Build the definition function
        // The function receives resolved values of dependencies in order
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const depParams = deps.join(", ");
        const fn = new AsyncFunction(...deps, `return (${expression})`);

        // Check for collision with notebook-defined variables
        if (runtime._scope && runtime._scope.has(name) && !this.injectedVariables.has(name)) {
          this.send({
            type: "define_response",
            requestId: message.requestId,
            name,
            success: false,
            error: `Cannot define "${name}": a variable with this name already exists in the notebook`,
          });
          return;
        }

        // Delete any existing injected variable with this name
        if (this.injectedVariables.has(name)) {
          this.injectedVariables.get(name).delete();
          this.injectedVariables.delete(name);
        }

        // Create the new variable in the runtime
        const variable = runtime.define(name, deps, fn);
        this.injectedVariables.set(name, variable);

        // Wait for the value to be computed
        const result = await this.getValueState(runtime, name, message.timeout || 5000);

        if (result.state === "fulfilled") {
          this.send({
            type: "define_response",
            requestId: message.requestId,
            name,
            success: true,
            state: "fulfilled",
            value: this.serializeValue(result.value),
            inputs: deps,
          });
        } else if (result.state === "pending") {
          this.send({
            type: "define_response",
            requestId: message.requestId,
            name,
            success: true,
            state: "pending",
            inputs: deps,
          });
        } else {
          this.send({
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
        this.send({
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
    detectDependencies(runtime, expression) {
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
        if (scopeNames.has(id) && !this.isJavaScriptKeyword(id)) {
          foundIdentifiers.add(id);
        }
      }

      return Array.from(foundIdentifiers);
    }

    /**
     * Check if a string is a JavaScript keyword or common global
     */
    isJavaScriptKeyword(word) {
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
    async handleDeleteVariableRequest(message) {
      const { name } = message;

      if (!this.injectedVariables.has(name)) {
        this.send({
          type: "delete_response",
          requestId: message.requestId,
          name,
          success: false,
          error: `No injected variable named "${name}" found`,
        });
        return;
      }

      try {
        const variable = this.injectedVariables.get(name);
        variable.delete();
        this.injectedVariables.delete(name);

        this.send({
          type: "delete_response",
          requestId: message.requestId,
          name,
          success: true,
        });
      } catch (error) {
        this.send({
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
    handleListInjectedVariablesRequest(message) {
      const names = Array.from(this.injectedVariables.keys());

      this.send({
        type: "injected_list_response",
        requestId: message.requestId,
        success: true,
        variables: names,
      });
    }

    /**
     * Get element and compute absolute coordinates for mouse events
     */
    getMouseEventTarget(selector, x = 0, y = 0) {
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
    handleMouseClickRequest(message) {
      const { selector, x = 0, y = 0, button = 0 } = message;

      try {
        const result = this.getMouseEventTarget(selector, x, y);
        if (result.error) {
          this.send({
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

        this.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: true,
          clientX,
          clientY,
        });
      } catch (error) {
        this.send({
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
    handleMouseDragRequest(message) {
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
        const startResult = this.getMouseEventTarget(selector, startX, startY);
        if (startResult.error) {
          this.send({
            type: "mouse_response",
            requestId: message.requestId,
            success: false,
            error: startResult.error,
          });
          return;
        }

        const endResult = this.getMouseEventTarget(selector, endX, endY);
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

            this.send({
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
        this.send({
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
    handleMouseWheelRequest(message) {
      const { selector, x = 0, y = 0, duration = 300, deltaX = 0, deltaY = 0 } = message;

      try {
        const result = this.getMouseEventTarget(selector, x, y);
        if (result.error) {
          this.send({
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
            this.send({
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
        this.send({
          type: "mouse_response",
          requestId: message.requestId,
          success: false,
          error: error.message,
        });
      }
    }

    send(message) {
      const data = JSON.stringify({
        ...message,
        sessionId: this.sessionId,
        timestamp: message.timestamp || Date.now(),
      });

      if (this.connected && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(data);
      } else {
        this.messageQueue.push(data);
      }
    }

    patchConsole() {
      const levels = ["log", "info", "warn", "error", "debug"];
      const earlyOriginal = window.__originalConsole || {};

      levels.forEach((level) => {
        this.originalConsole[level] = earlyOriginal[level] || console[level];

        console[level] = (...args) => {
          this.originalConsole[level](...args);

          this.send({
            type: "log",
            data: {
              level,
              args: args.map((arg) => this.serializeArg(arg)),
            },
          });
        };
      });

      if (window.__earlyConsoleLogs && window.__earlyConsoleLogs.length > 0) {
        window.__earlyConsoleLogs.forEach((log) => {
          this.send({
            type: "log",
            timestamp: log.timestamp,
            data: {
              level: log.level,
              args: log.args.map((arg) => this.serializeArg(arg)),
            },
          });
        });
        window.__earlyConsoleLogs = [];
      }
    }

    serializeArg(arg) {
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

    serializeValue(value, maxDepth, currentDepth, seen) {
      maxDepth = maxDepth || 10;
      currentDepth = currentDepth || 0;
      seen = seen || new WeakMap();

      const MAX_STRING_LENGTH = 10000;
      const MAX_ARRAY_LENGTH = 100;

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
                this.serializeValue(v, maxDepth, currentDepth + 1, seen)
              ),
            truncated: true,
          };
        }
        return value.map((v) =>
          this.serializeValue(v, maxDepth, currentDepth + 1, seen)
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
            this.serializeValue(k, maxDepth, currentDepth + 1, seen),
            this.serializeValue(v, maxDepth, currentDepth + 1, seen),
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
            this.serializeValue(v, maxDepth, currentDepth + 1, seen)
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
            result[key] = this.serializeValue(
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

    watchForErrors() {
      window.addEventListener("error", (event) => {
        this.send({
          type: "error",
          data: {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error?.stack,
            source: "window.error",
          },
        });
      });

      window.addEventListener("unhandledrejection", (event) => {
        this.send({
          type: "error",
          data: {
            message: "Unhandled Promise Rejection: " + event.reason,
            stack: event.reason?.stack,
            source: "unhandledrejection",
          },
        });
      });
    }

    watchForRuntimeErrors() {
      const checkErrors = () => {
        const errorElements = document.querySelectorAll(".observablehq--error");

        errorElements.forEach((el) => {
          if (el.dataset.debugReported) return;
          el.dataset.debugReported = "true";

          const cellElement = el.closest(".observablehq--cell");
          const cellId = cellElement?.id?.replace("cell-", "") || "unknown";
          const inspectElement = el.querySelector(".observablehq--inspect");
          const message = inspectElement?.textContent || "Unknown error";

          this.send({
            type: "runtime_error",
            data: { message, cellId, html: el.innerHTML.slice(0, 500) },
          });
        });
      };

      this.errorCheckInterval = setInterval(checkErrors, ERROR_CHECK_INTERVAL);

      this.errorObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (
                node.classList?.contains("observablehq--error") ||
                node.querySelector?.(".observablehq--error")
              ) {
                checkErrors();
                break;
              }
            }
          }
        }
      });

      this.errorObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    endSession() {
      if (this.sessionEnded) return;

      this.sessionEnded = true;

      this.send({
        type: "session_end",
        data: { duration: Date.now() - this.sessionStartTime },
      });

      if (this.errorCheckInterval) clearInterval(this.errorCheckInterval);
      if (this.errorObserver) this.errorObserver.disconnect();
    }
  }

  // Initialize debug client - runtime will be found via polling in getRuntimeModule
  function initDebugClient() {
    const client = new DebugClient();
    client.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDebugClient);
  } else {
    initDebugClient();
  }
})();
