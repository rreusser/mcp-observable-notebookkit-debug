/**
 * MCP Event Log Overlay
 * Shows incoming MCP events as toasts with expandable history
 * Clicking an event opens a detail panel to the left
 */

import { showClick, showHover, showDrag, showWheel } from "./mouse-visualizer.js";

const TOAST_DURATION = 2500;
const MAX_EVENTS = 50;
const EXPANDED_STORAGE_KEY = '__mcp_event_log_expanded';

// Mouse event types that can be replayed
const MOUSE_EVENTS = ['MouseClick', 'MouseHover', 'MouseDrag', 'MouseWheel'];

let container = null;
let toastContainer = null;
let historyPanel = null;
let detailPanel = null;
let toggleButton = null;
let expanded = false;
let events = [];
let eventsByRequestId = new Map();
let selectedEventIndex = null;

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
  background: rgba(0, 0, 0, 0.3);
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
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatArgs(args, excludeKeys = ['requestId', 'timestamp', 'sessionId', 'type', 'label']) {
  try {
    const cleaned = { ...args };
    excludeKeys.forEach(key => delete cleaned[key]);

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

function createToast(eventName, label) {
  const toast = document.createElement('div');
  toast.className = 'mcp-toast';

  if (label) {
    toast.innerHTML = `${eventName}<span class="mcp-toast-label">(${label})</span>`;
  } else {
    toast.textContent = eventName;
  }

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fading');
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION);
}

/**
 * Render the detail panel for a selected event
 */
function renderDetailPanel(event, itemElement) {
  if (!detailPanel || !event) {
    if (detailPanel) {
      detailPanel.classList.remove('visible');
    }
    return;
  }

  // Position the caret to align with the selected item
  const listRect = historyPanel.querySelector('.mcp-event-log-list').getBoundingClientRect();
  const itemRect = itemElement.getBoundingClientRect();
  const caretTop = itemRect.top - listRect.top + historyPanel.querySelector('.mcp-event-log-header').offsetHeight + 16;
  detailPanel.style.setProperty('--caret-top', `${Math.max(20, Math.min(caretTop, 360))}px`);

  const titleEl = detailPanel.querySelector('.mcp-detail-title');
  const contentEl = detailPanel.querySelector('.mcp-detail-content');

  const labelHtml = event.label ? ` <span class="mcp-event-label">(${event.label})</span>` : '';
  titleEl.innerHTML = `${event.name}${labelHtml}`;

  let html = '';

  // Meta info
  html += `<div class="mcp-detail-meta">`;
  html += `<div class="mcp-detail-meta-item"><span class="mcp-detail-meta-label">Time:</span> ${formatTime(event.timestamp)}</div>`;
  if (event.response) {
    const status = event.response.success ? 'success' : 'error';
    html += `<div class="mcp-detail-meta-item"><span class="mcp-detail-status ${status}">${status}</span></div>`;
  } else {
    html += `<div class="mcp-detail-meta-item"><span class="mcp-detail-status pending">pending</span></div>`;
  }
  html += `</div>`;

  // Request section
  const argsStr = formatArgs(event.args);
  if (argsStr) {
    html += `<div class="mcp-detail-section">`;
    html += `<div class="mcp-detail-section-title">Request</div>`;
    html += `<pre>${escapeHtml(argsStr)}</pre>`;
    html += `</div>`;
  }

  // Response section
  if (event.response) {
    html += `<div class="mcp-detail-section">`;
    html += `<div class="mcp-detail-section-title">Response</div>`;

    // Check for image data in response
    const resp = event.response;
    if (resp.imageData) {
      // Add data URI prefix if not already present
      const src = resp.imageData.startsWith('data:')
        ? resp.imageData
        : `data:image/png;base64,${resp.imageData}`;
      html += `<img src="${src}" alt="Response image" />`;
    }

    // Format response, excluding some internal fields
    const responseStr = formatArgs(resp, ['requestId', 'timestamp', 'sessionId', 'type', 'imageData']);
    if (responseStr) {
      html += `<pre>${escapeHtml(responseStr)}</pre>`;
    }

    html += `</div>`;
  }

  contentEl.innerHTML = html;
  detailPanel.classList.add('visible');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function closeDetailPanel() {
  if (detailPanel) {
    detailPanel.classList.remove('visible');
  }
  selectedEventIndex = null;
  // Remove selection from all items
  historyPanel?.querySelectorAll('.mcp-event-item.selected').forEach(el => {
    el.classList.remove('selected');
  });
}

function renderHistory() {
  if (!historyPanel) return;

  const list = historyPanel.querySelector('.mcp-event-log-list');
  if (!list) return;

  if (events.length === 0) {
    list.innerHTML = '<div class="mcp-event-empty">No events yet</div>';
    closeDetailPanel();
    return;
  }

  list.innerHTML = events.map((event, index) => {
    const isReplayable = MOUSE_EVENTS.includes(event.name);
    const isSelected = selectedEventIndex === index;
    const labelHtml = event.label ? `<span class="mcp-event-label">(${event.label})</span>` : '';
    const hasResponse = event.response ? ' has-response' : '';
    return `
      <div class="mcp-event-item${isReplayable ? ' replayable' : ''}${isSelected ? ' selected' : ''}${hasResponse}" data-index="${index}">
        <div class="mcp-event-summary">
          <span class="mcp-event-name">${event.name}${labelHtml}</span>
          <span class="mcp-event-time">${formatTime(event.timestamp)}</span>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers for selecting and hover handlers for replay
  list.querySelectorAll('.mcp-event-item').forEach(item => {
    const index = parseInt(item.dataset.index, 10);
    const event = events[index];

    // Click to select and show detail panel
    item.addEventListener('click', (e) => {
      e.stopPropagation();

      // Toggle selection
      if (selectedEventIndex === index) {
        closeDetailPanel();
      } else {
        // Remove previous selection
        list.querySelectorAll('.mcp-event-item.selected').forEach(el => {
          el.classList.remove('selected');
        });
        item.classList.add('selected');
        selectedEventIndex = index;
        renderDetailPanel(event, item);
      }
    });

    // Hover to replay mouse events
    if (MOUSE_EVENTS.includes(event.name)) {
      item.addEventListener('mouseenter', () => {
        replayMouseEvent(event);
      });
    }
  });

  // Update detail panel if an event is selected
  if (selectedEventIndex !== null && selectedEventIndex < events.length) {
    const selectedItem = list.querySelector(`[data-index="${selectedEventIndex}"]`);
    if (selectedItem) {
      renderDetailPanel(events[selectedEventIndex], selectedItem);
    }
  }
}

function toggleExpanded() {
  expanded = !expanded;
  toggleButton.classList.toggle('expanded', expanded);
  historyPanel.classList.toggle('visible', expanded);
  toastContainer.style.display = expanded ? 'none' : 'flex';

  // Persist to localStorage
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? '1' : '0');
  } catch (e) {
    // Ignore storage errors (e.g., private browsing)
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

function init() {
  if (container) return;

  // Load expanded state from localStorage
  try {
    expanded = localStorage.getItem(EXPANDED_STORAGE_KEY) === '1';
  } catch (e) {
    // Ignore storage errors
  }

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

  // Detail panel (to the left of history)
  detailPanel = document.createElement('div');
  detailPanel.className = 'mcp-detail-panel';
  detailPanel.innerHTML = `
    <div class="mcp-detail-header">
      <span class="mcp-detail-title"></span>
      <button class="mcp-detail-close">&times;</button>
    </div>
    <div class="mcp-detail-content"></div>
  `;
  container.appendChild(detailPanel);

  // Close detail panel button
  detailPanel.querySelector('.mcp-detail-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeDetailPanel();
  });

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

  // Outer click handler to close the panel
  document.addEventListener('click', (e) => {
    if (!expanded) return;

    // Check if click is outside the event log UI
    if (!container.contains(e.target)) {
      toggleExpanded();
    }
  });

  document.body.appendChild(container);

  // Apply initial expanded state from localStorage
  if (expanded) {
    toggleButton.classList.add('expanded');
    historyPanel.classList.add('visible');
    toastContainer.style.display = 'none';
    renderHistory();
  }
}

export function logEvent(eventName, args = {}) {
  init();

  // Extract label and requestId from args
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

  // Add to history
  events.unshift(event);

  // Store by requestId for response matching
  if (requestId) {
    eventsByRequestId.set(requestId, event);
  }

  // Trim history
  if (events.length > MAX_EVENTS) {
    const removed = events.splice(MAX_EVENTS);
    // Clean up requestId map for removed events
    removed.forEach(e => {
      if (e.requestId) {
        eventsByRequestId.delete(e.requestId);
      }
    });
  }

  // Show toast if not expanded
  if (!expanded) {
    createToast(eventName, label);
  } else {
    renderHistory();
  }
}

/**
 * Log a response and link it to the original request
 */
export function logResponse(requestId, response) {
  const event = eventsByRequestId.get(requestId);
  if (event) {
    event.response = response;

    // Re-render if expanded and this event is selected
    if (expanded) {
      renderHistory();
    }
  }
}

// Export for debugging
export function getEventLog() {
  return { events, expanded, container, eventsByRequestId };
}

// Export init so it can be called on WebSocket connect
export { init as initEventLog };

// Expose globally for debugging in console
if (typeof window !== 'undefined') {
  window.__mcpEventLog = { getEventLog, logResponse };
}
