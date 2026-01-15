/**
 * Mouse Interaction Visualizer
 * Shows visual feedback for simulated mouse events
 */

let initialized = false;
let styleEl = null;

const styles = `
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
`;

function init() {
  if (initialized) return;
  initialized = true;

  styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);
}

function createEl(className) {
  init();
  const el = document.createElement('div');
  el.className = `mcp-mouse-viz ${className}`;
  document.body.appendChild(el);
  return el;
}

function positionAt(el, x, y) {
  // Convert viewport coordinates to document coordinates
  el.style.left = `${x + window.scrollX}px`;
  el.style.top = `${y + window.scrollY}px`;
}

/**
 * Show a click ripple at the given coordinates
 */
export function showClick(clientX, clientY) {
  const el = createEl('mcp-click-ripple');
  positionAt(el, clientX, clientY);

  setTimeout(() => el.remove(), 1500);
}

/**
 * Show a hover indicator at the given coordinates
 * Returns a function to dismiss it
 */
export function showHover(clientX, clientY) {
  const el = createEl('mcp-hover-indicator');

  // Strict render order - strokes first, then fills:

  // 1. Crosshair STROKE + glow
  const crosshairStroke = document.createElement('div');
  crosshairStroke.className = 'mcp-hover-crosshair-stroke';
  el.appendChild(crosshairStroke);

  // 2. Circle STROKE + glow
  const circleStroke = document.createElement('div');
  circleStroke.className = 'mcp-hover-circle-stroke';
  el.appendChild(circleStroke);

  // 3. Crosshair FILL
  const crosshairFill = document.createElement('div');
  crosshairFill.className = 'mcp-hover-crosshair-fill';
  el.appendChild(crosshairFill);

  // 4. Circle FILL
  const circleFill = document.createElement('div');
  circleFill.className = 'mcp-hover-circle-fill';
  el.appendChild(circleFill);

  // 5. Label
  const label = document.createElement('div');
  label.className = 'mcp-hover-label';
  label.textContent = 'HOVER';
  el.appendChild(label);

  positionAt(el, clientX, clientY);

  // Auto-fade after a longer delay for debugging
  const timeout = setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => el.remove(), 500);
  }, 3000);

  return () => {
    clearTimeout(timeout);
    el.classList.add('fading');
    setTimeout(() => el.remove(), 500);
  };
}

/**
 * Show a drag visualization from start to end (legacy - shows complete drag after the fact)
 * Strict render order: all strokes first, then all fills
 */
export function showDrag(startX, startY, endX, endY) {
  const group = createEl('mcp-drag-group');

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // Calculate line
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;

  // === STROKES (render first) ===

  const startStroke = document.createElement('div');
  startStroke.className = 'mcp-drag-start-stroke';
  startStroke.style.position = 'absolute';
  startStroke.style.left = `${startX + scrollX}px`;
  startStroke.style.top = `${startY + scrollY}px`;
  group.appendChild(startStroke);

  const lineStroke = document.createElement('div');
  lineStroke.className = 'mcp-drag-line-stroke';
  lineStroke.style.position = 'absolute';
  lineStroke.style.left = `${startX + scrollX}px`;
  lineStroke.style.top = `${startY + scrollY}px`;
  lineStroke.style.width = `${length}px`;
  lineStroke.style.transform = `rotate(${angle}deg)`;
  group.appendChild(lineStroke);

  const endStroke = document.createElement('div');
  endStroke.className = 'mcp-drag-end-stroke';
  endStroke.style.position = 'absolute';
  endStroke.style.left = `${endX + scrollX}px`;
  endStroke.style.top = `${endY + scrollY}px`;
  group.appendChild(endStroke);

  // === FILLS (render on top) ===

  const startFill = document.createElement('div');
  startFill.className = 'mcp-drag-start-fill';
  startFill.style.position = 'absolute';
  startFill.style.left = `${startX + scrollX}px`;
  startFill.style.top = `${startY + scrollY}px`;
  group.appendChild(startFill);

  const lineFill = document.createElement('div');
  lineFill.className = 'mcp-drag-line-fill';
  lineFill.style.position = 'absolute';
  lineFill.style.left = `${startX + scrollX}px`;
  lineFill.style.top = `${startY + scrollY}px`;
  lineFill.style.width = `${length}px`;
  lineFill.style.transform = `rotate(${angle}deg)`;
  group.appendChild(lineFill);

  const endFill = document.createElement('div');
  endFill.className = 'mcp-drag-end-fill';
  endFill.style.position = 'absolute';
  endFill.style.left = `${endX + scrollX}px`;
  endFill.style.top = `${endY + scrollY}px`;
  group.appendChild(endFill);

  // === LABELS ===

  const startLabel = document.createElement('div');
  startLabel.className = 'mcp-drag-label';
  startLabel.textContent = 'START';
  startLabel.style.position = 'absolute';
  startLabel.style.left = `${startX + scrollX}px`;
  startLabel.style.top = `${startY + scrollY}px`;
  group.appendChild(startLabel);

  const endLabel = document.createElement('div');
  endLabel.className = 'mcp-drag-label';
  endLabel.textContent = 'END';
  endLabel.style.position = 'absolute';
  endLabel.style.left = `${endX + scrollX}px`;
  endLabel.style.top = `${endY + scrollY}px`;
  group.appendChild(endLabel);

  const endDot = document.createElement('div');
  endDot.className = 'mcp-drag-end-dot';
  endDot.style.position = 'absolute';
  endDot.style.left = `${endX + scrollX}px`;
  endDot.style.top = `${endY + scrollY}px`;
  group.appendChild(endDot);

  // Fade out after longer delay
  setTimeout(() => {
    group.classList.add('fading');
    setTimeout(() => group.remove(), 800);
  }, 3000);
}

/**
 * Start a live drag visualization - returns controller object
 * Strict render order: all strokes first, then all fills
 */
export function startLiveDrag(startX, startY) {
  init();

  const group = document.createElement('div');
  group.className = 'mcp-mouse-viz mcp-drag-group';
  document.body.appendChild(group);

  // Capture scroll position at start
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // === STROKES (render first) ===

  // 1. Start stroke
  const startStroke = document.createElement('div');
  startStroke.className = 'mcp-drag-start-stroke';
  startStroke.style.position = 'absolute';
  startStroke.style.left = `${startX + scrollX}px`;
  startStroke.style.top = `${startY + scrollY}px`;
  group.appendChild(startStroke);

  // 2. Line stroke (starts with 0 width)
  const lineStroke = document.createElement('div');
  lineStroke.className = 'mcp-drag-line-stroke';
  lineStroke.style.position = 'absolute';
  lineStroke.style.left = `${startX + scrollX}px`;
  lineStroke.style.top = `${startY + scrollY}px`;
  lineStroke.style.width = '0px';
  lineStroke.style.transform = 'rotate(0deg)';
  group.appendChild(lineStroke);

  // 3. End stroke (placeholder, will be positioned later)
  const endStroke = document.createElement('div');
  endStroke.className = 'mcp-drag-end-stroke';
  endStroke.style.position = 'absolute';
  endStroke.style.left = `${startX + scrollX}px`;
  endStroke.style.top = `${startY + scrollY}px`;
  endStroke.style.opacity = '0';
  group.appendChild(endStroke);

  // === FILLS (render on top) ===

  // 4. Start fill
  const startFill = document.createElement('div');
  startFill.className = 'mcp-drag-start-fill';
  startFill.style.position = 'absolute';
  startFill.style.left = `${startX + scrollX}px`;
  startFill.style.top = `${startY + scrollY}px`;
  group.appendChild(startFill);

  // 5. Line fill (starts with 0 width)
  const lineFill = document.createElement('div');
  lineFill.className = 'mcp-drag-line-fill';
  lineFill.style.position = 'absolute';
  lineFill.style.left = `${startX + scrollX}px`;
  lineFill.style.top = `${startY + scrollY}px`;
  lineFill.style.width = '0px';
  lineFill.style.transform = 'rotate(0deg)';
  group.appendChild(lineFill);

  // 6. End fill (placeholder)
  const endFill = document.createElement('div');
  endFill.className = 'mcp-drag-end-fill';
  endFill.style.position = 'absolute';
  endFill.style.left = `${startX + scrollX}px`;
  endFill.style.top = `${startY + scrollY}px`;
  endFill.style.opacity = '0';
  group.appendChild(endFill);

  // === LABELS (on top of everything) ===

  // Start label
  const startLabel = document.createElement('div');
  startLabel.className = 'mcp-drag-label';
  startLabel.textContent = 'START';
  startLabel.style.position = 'absolute';
  startLabel.style.left = `${startX + scrollX}px`;
  startLabel.style.top = `${startY + scrollY}px`;
  group.appendChild(startLabel);

  // End label (hidden initially)
  const endLabel = document.createElement('div');
  endLabel.className = 'mcp-drag-label';
  endLabel.textContent = 'END';
  endLabel.style.position = 'absolute';
  endLabel.style.opacity = '0';
  group.appendChild(endLabel);

  // End dot (hidden initially)
  const endDot = document.createElement('div');
  endDot.className = 'mcp-drag-end-dot';
  endDot.style.position = 'absolute';
  endDot.style.opacity = '0';
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
      // Final line update
      const dx = endX - startX;
      const dy = endY - startY;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;

      lineStroke.style.width = `${length}px`;
      lineStroke.style.transform = `rotate(${angle}deg)`;
      lineFill.style.width = `${length}px`;
      lineFill.style.transform = `rotate(${angle}deg)`;

      // Show end elements
      endStroke.style.left = `${endX + scrollX}px`;
      endStroke.style.top = `${endY + scrollY}px`;
      endStroke.style.opacity = '1';

      endFill.style.left = `${endX + scrollX}px`;
      endFill.style.top = `${endY + scrollY}px`;
      endFill.style.opacity = '1';

      endLabel.style.left = `${endX + scrollX}px`;
      endLabel.style.top = `${endY + scrollY}px`;
      endLabel.style.opacity = '1';

      endDot.style.left = `${endX + scrollX}px`;
      endDot.style.top = `${endY + scrollY}px`;
      endDot.style.opacity = '1';

      // Fade out after delay
      setTimeout(() => {
        group.classList.add('fading');
        setTimeout(() => group.remove(), 800);
      }, 2000);
    },

    /**
     * Cancel/remove the visualization
     */
    cancel() {
      group.remove();
    }
  };
}

/**
 * Show a wheel/scroll indicator
 */
export function showWheel(clientX, clientY, deltaY) {
  const el = createEl('mcp-wheel-indicator');
  positionAt(el, clientX, clientY);

  // Solid circle
  const circle = document.createElement('div');
  circle.className = 'mcp-wheel-circle';
  el.appendChild(circle);

  // Show arrow based on scroll direction
  const arrow = document.createElement('div');
  arrow.className = `mcp-wheel-arrow ${deltaY > 0 ? 'down' : 'up'}`;
  el.appendChild(arrow);

  const label = document.createElement('div');
  label.className = 'mcp-wheel-label';
  label.textContent = 'SCROLL';
  el.appendChild(label);

  // Fade out after longer delay
  setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => el.remove(), 400);
  }, 1500);
}

// Expose for debugging
if (typeof window !== 'undefined') {
  window.__mcpMouseViz = { showClick, showHover, showDrag, showWheel };
}
