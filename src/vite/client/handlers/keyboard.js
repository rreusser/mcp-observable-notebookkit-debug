/**
 * Keyboard event handler (SendKeys)
 */

/**
 * Handle SendKeys request - simulate keyboard input
 * Dispatches keydown, keypress (for printable), and keyup events
 */
export function handleSendKeysRequest(client, message) {
  const { selector, keys, modifiers = {} } = message;

  try {
    // Find target element
    let target = document.activeElement || document.body;
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) {
        client.send({
          type: "keyboard_response",
          requestId: message.requestId,
          success: false,
          error: `Element not found: ${selector}`,
        });
        return;
      }
      target = el;
      // Focus the element if it can receive focus
      if (typeof target.focus === "function") {
        target.focus();
      }
    }

    const { ctrlKey = false, altKey = false, shiftKey = false, metaKey = false } = modifiers;

    // Parse keys - can be a string of characters or special key names like {Enter}, {Tab}, etc.
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
        metaKey: keyInfo.metaKey ?? metaKey,
      };

      // Dispatch keydown
      const keydownEvent = new KeyboardEvent("keydown", eventInit);
      target.dispatchEvent(keydownEvent);

      // For printable characters, also dispatch keypress and input events
      if (keyInfo.printable && !keydownEvent.defaultPrevented) {
        target.dispatchEvent(new KeyboardEvent("keypress", eventInit));

        // If target is an input or textarea, update its value
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          target.value = target.value.slice(0, start) + keyInfo.key + target.value.slice(end);
          target.selectionStart = target.selectionEnd = start + 1;
          target.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }

      // Dispatch keyup
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      keysSent++;
    }

    client.send({
      type: "keyboard_response",
      requestId: message.requestId,
      success: true,
      keysSent,
      target: target.tagName.toLowerCase() + (target.id ? `#${target.id}` : ""),
    });
  } catch (error) {
    client.send({
      type: "keyboard_response",
      requestId: message.requestId,
      success: false,
      error: error.message,
    });
  }
}

/**
 * Parse a key string into a sequence of key info objects
 * Supports:
 * - Plain characters: "hello" -> h, e, l, l, o
 * - Special keys in braces: "{Enter}", "{Tab}", "{Escape}", "{Backspace}", "{Delete}"
 * - Arrow keys: "{ArrowUp}", "{ArrowDown}", "{ArrowLeft}", "{ArrowRight}"
 * - Modifier combos: "{Ctrl+a}", "{Shift+Tab}"
 */
function parseKeys(keys) {
  const result = [];
  let i = 0;

  while (i < keys.length) {
    if (keys[i] === "{") {
      // Find closing brace
      const end = keys.indexOf("}", i);
      if (end === -1) {
        // No closing brace, treat as literal
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

/**
 * Convert a character to key info
 */
function charToKeyInfo(char) {
  const code = `Key${char.toUpperCase()}`;
  const keyCode = char.toUpperCase().charCodeAt(0);

  return {
    key: char,
    code,
    keyCode,
    printable: true,
    shiftKey: char !== char.toLowerCase(),
  };
}

/**
 * Convert a special key name to key info
 * Supports modifier combos like "Ctrl+a"
 */
function specialKeyToKeyInfo(special) {
  // Check for modifier combos
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

  // If keyName is a single character, treat it as a character key
  if (keyName.length === 1) {
    return { ...charToKeyInfo(keyName), ...modifiers };
  }

  // Special keys
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
    F12: { key: "F12", code: "F12", keyCode: 123, printable: false },
  };

  const keyInfo = specialKeys[keyName];
  if (keyInfo) {
    return { ...keyInfo, ...modifiers };
  }

  // Unknown special key, return as-is
  return {
    key: keyName,
    code: keyName,
    keyCode: 0,
    printable: false,
    ...modifiers,
  };
}
