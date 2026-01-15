/**
 * MCP Event Log Overlay
 * Shows incoming MCP events as toasts with expandable history
 */

import { showClick, showHover, showDrag, showWheel } from "./mouse-visualizer.js";

const TOAST_DURATION = 2500;
const MAX_EVENTS = 50;

// Mouse event types that can be replayed
const MOUSE_EVENTS = ['MouseClick', 'MouseHover', 'MouseDrag', 'MouseWheel'];

let container = null;
let toastContainer = null;
let historyPanel = null;
let toggleButton = null;
let expanded = false;
let events = [];

const styles = `
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
  width: 320px;
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
  background: rgba(255, 255, 255, 0.03);
}

.mcp-event-item:last-child {
  border-bottom: none;
}

.mcp-event-summary {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.mcp-event-name {
  color: #6ee7b7;
  font-weight: 500;
}

.mcp-event-time {
  color: rgba(255, 255, 255, 0.3);
  font-size: 10px;
}

.mcp-event-args {
  display: none;
  padding: 0 12px 10px 12px;
}

.mcp-event-item.expanded .mcp-event-args {
  display: block;
}

.mcp-event-args pre {
  margin: 0;
  padding: 8px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
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
  opacity: 0.5;
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.mcp-event-item.replayable:hover .mcp-event-name::before {
  opacity: 1;
  transform: scale(1.3);
}

`;

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatArgs(args) {
  try {
    const cleaned = { ...args };
    // Remove requestId and timestamp for cleaner display
    delete cleaned.requestId;
    delete cleaned.timestamp;
    delete cleaned.sessionId;
    delete cleaned.type;

    if (Object.keys(cleaned).length === 0) {
      return null;
    }
    return JSON.stringify(cleaned, null, 2);
  } catch (e) {
    return String(args);
  }
}

/**
 * Compute absolute coordinates from event args (selector + relative x/y)
 */
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

/**
 * Replay a mouse event visualization
 */
function replayMouseEvent(event) {
  const args = event.args;

  switch (event.name) {
    case 'MouseClick': {
      const { clientX, clientY } = getAbsoluteCoords(args.selector, args.x, args.y);
      showClick(clientX, clientY);
      break;
    }
    case 'MouseHover': {
      const { clientX, clientY } = getAbsoluteCoords(args.selector, args.x, args.y);
      showHover(clientX, clientY);
      break;
    }
    case 'MouseDrag': {
      const start = getAbsoluteCoords(args.selector, args.startX, args.startY);
      const end = getAbsoluteCoords(args.selector, args.endX, args.endY);
      showDrag(start.clientX, start.clientY, end.clientX, end.clientY);
      break;
    }
    case 'MouseWheel': {
      const { clientX, clientY } = getAbsoluteCoords(args.selector, args.x, args.y);
      showWheel(clientX, clientY, args.deltaY || 0);
      break;
    }
  }
}

function createToast(eventName) {
  const toast = document.createElement('div');
  toast.className = 'mcp-toast';
  toast.textContent = eventName;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fading');
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION);
}

function renderHistory() {
  if (!historyPanel) return;

  const list = historyPanel.querySelector('.mcp-event-log-list');
  if (!list) return;

  if (events.length === 0) {
    list.innerHTML = '<div class="mcp-event-empty">No events yet</div>';
    return;
  }

  list.innerHTML = events.map((event, index) => {
    const argsStr = formatArgs(event.args);
    const isReplayable = MOUSE_EVENTS.includes(event.name);
    return `
      <div class="mcp-event-item${isReplayable ? ' replayable' : ''}" data-index="${index}">
        <div class="mcp-event-summary">
          <span class="mcp-event-name">${event.name}</span>
          <span class="mcp-event-time">${formatTime(event.timestamp)}</span>
        </div>
        ${argsStr ? `<div class="mcp-event-args"><pre>${argsStr}</pre></div>` : ''}
      </div>
    `;
  }).join('');

  // Add click handlers for expanding and hover handlers for replay
  list.querySelectorAll('.mcp-event-item').forEach(item => {
    const index = parseInt(item.dataset.index, 10);
    const event = events[index];

    // Click to expand args
    item.addEventListener('click', () => {
      item.classList.toggle('expanded');
    });

    // Hover to replay mouse events
    if (MOUSE_EVENTS.includes(event.name)) {
      item.addEventListener('mouseenter', () => {
        replayMouseEvent(event);
      });
    }
  });
}

function toggleExpanded() {
  expanded = !expanded;
  toggleButton.classList.toggle('expanded', expanded);
  historyPanel.classList.toggle('visible', expanded);
  toastContainer.style.display = expanded ? 'none' : 'flex';

  if (expanded) {
    renderHistory();
  }
}

function clearHistory() {
  events = [];
  renderHistory();
}

function init() {
  if (container) return;

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);

  // Create container
  container = document.createElement('div');
  container.className = 'mcp-event-log';

  // Toast container
  toastContainer = document.createElement('div');
  toastContainer.className = 'mcp-event-log-toasts';
  container.appendChild(toastContainer);

  // History panel
  historyPanel = document.createElement('div');
  historyPanel.className = 'mcp-event-log-history';
  historyPanel.innerHTML = `
    <div class="mcp-event-log-header">
      <span>MCP Events</span>
      <button class="mcp-event-log-clear">Clear</button>
    </div>
    <div class="mcp-event-log-list"></div>
  `;
  container.appendChild(historyPanel);

  // Toggle button
  toggleButton = document.createElement('button');
  toggleButton.className = 'mcp-event-log-toggle';
  toggleButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  toggleButton.addEventListener('click', toggleExpanded);
  container.appendChild(toggleButton);

  // Clear button handler
  historyPanel.querySelector('.mcp-event-log-clear').addEventListener('click', (e) => {
    e.stopPropagation();
    clearHistory();
  });

  document.body.appendChild(container);
}

export function logEvent(eventName, args = {}) {
  init();

  // Add to history
  events.unshift({
    name: eventName,
    args,
    timestamp: Date.now()
  });

  // Trim history
  if (events.length > MAX_EVENTS) {
    events = events.slice(0, MAX_EVENTS);
  }

  // Show toast if not expanded
  if (!expanded) {
    createToast(eventName);
  } else {
    renderHistory();
  }
}

// Export for debugging
export function getEventLog() {
  return { events, expanded, container };
}

// Expose globally for debugging in console
if (typeof window !== 'undefined') {
  window.__mcpEventLog = { getEventLog };
}
