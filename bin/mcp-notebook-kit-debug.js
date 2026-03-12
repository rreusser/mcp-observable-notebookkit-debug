#!/usr/bin/env node
/**
 * MCP Server for Observable Notebook Debugging
 *
 * Integrated debug server that provides:
 * - WebSocket server for browser connections
 * - HTTP server for session data retrieval
 * - MCP tools for notebook debugging
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import http from 'http';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

// Port range for dynamic allocation
const BASE_HTTP_PORT = 9898;
const BASE_WS_PORT = 9899;
const PORT_RANGE = 100; // Try up to 100 ports

const DEFAULT_TIMEOUT = 5000;
const COMPLETION_TIMEOUT = 30000;

// Runtime port values (set during startup)
let HTTP_PORT = BASE_HTTP_PORT;
let WS_PORT = BASE_WS_PORT;

// Unique instance ID for this server
const INSTANCE_ID = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Debug directory for this project
const DEBUG_DIR = join(process.cwd(), '.notebook-kit-debug');
const REGISTRY_FILE = join(DEBUG_DIR, 'registry.json');
const RESPONSES_DIR = join(DEBUG_DIR, 'responses');

// Track notebooks this instance is handling
const claimedNotebooks = new Set();

// Large response handling
const LARGE_RESPONSE_THRESHOLD = 3000; // chars

/**
 * Ensure the debug directory exists
 */
async function ensureDebugDir() {
  if (!existsSync(DEBUG_DIR)) {
    await mkdir(DEBUG_DIR, { recursive: true });
  }
}

/**
 * Check if a process is still running
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the instance registry, pruning dead instances
 */
async function readRegistry() {
  await ensureDebugDir();

  let registry = { instances: {} };

  try {
    if (existsSync(REGISTRY_FILE)) {
      const content = await import('fs/promises').then(fs => fs.readFile(REGISTRY_FILE, 'utf-8'));
      // Handle empty file gracefully
      if (content.trim()) {
        registry = JSON.parse(content);
      }
    }
  } catch (err) {
    console.error('[Server] Could not read registry:', err.message);
    registry = { instances: {} };
  }

  // Ensure instances object exists
  if (!registry.instances) {
    registry.instances = {};
  }

  // Prune dead instances
  const deadInstances = [];
  for (const [id, info] of Object.entries(registry.instances)) {
    if (!isProcessAlive(info.pid)) {
      deadInstances.push(id);
    }
  }

  if (deadInstances.length > 0) {
    for (const id of deadInstances) {
      delete registry.instances[id];
    }
    console.error(`[Server] Pruned ${deadInstances.length} dead instance(s) from registry`);
  }

  // Clear owner if owner is dead
  if (registry.owner && !registry.instances[registry.owner]) {
    console.error(`[Server] Owner ${registry.owner} is dead, clearing ownership`);
    registry.owner = null;
  }

  return registry;
}

/**
 * Write the instance registry
 */
async function writeRegistry(registry) {
  await ensureDebugDir();
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Register this instance in the registry
 */
async function registerInstance() {
  const registry = await readRegistry();

  registry.instances[INSTANCE_ID] = {
    pid: process.pid,
    ws: WS_PORT,
    http: HTTP_PORT,
    startedAt: Date.now(),
    notebooks: []
  };

  await writeRegistry(registry);
  console.error(`[Server] Registered instance ${INSTANCE_ID} (ws: ${WS_PORT}, http: ${HTTP_PORT})`);
}

/**
 * Unregister this instance from the registry
 */
async function unregisterInstance() {
  try {
    const registry = await readRegistry();
    // Release ownership if we were the owner
    if (registry.owner === INSTANCE_ID) {
      registry.owner = null;
      console.error(`[Server] Released ownership: ${INSTANCE_ID}`);
    }
    delete registry.instances[INSTANCE_ID];
    await writeRegistry(registry);
    console.error(`[Server] Unregistered instance ${INSTANCE_ID}`);
  } catch (err) {
    console.error('[Server] Error unregistering:', err.message);
  }
}

/**
 * Find a live owner instance in the registry
 * Returns { id, ...info } if found, null otherwise
 */
async function findLiveOwner() {
  const registry = await readRegistry();

  if (!registry.owner) return null;

  const ownerInfo = registry.instances[registry.owner];
  if (!ownerInfo) return null;

  // Owner is alive (readRegistry already pruned dead instances)
  return { id: registry.owner, ...ownerInfo };
}

/**
 * Set this instance as the owner in the registry
 */
async function becomeOwner() {
  const registry = await readRegistry();
  registry.owner = INSTANCE_ID;
  if (registry.instances[INSTANCE_ID]) {
    registry.instances[INSTANCE_ID].isOwner = true;
  }
  await writeRegistry(registry);
  console.error(`[Server] Became owner: ${INSTANCE_ID}`);
}

/**
 * Clear owner status when shutting down (if we're the owner)
 */
async function releaseOwnership() {
  try {
    const registry = await readRegistry();
    if (registry.owner === INSTANCE_ID) {
      registry.owner = null;
      console.error(`[Server] Released ownership: ${INSTANCE_ID}`);
    }
    if (registry.instances[INSTANCE_ID]) {
      delete registry.instances[INSTANCE_ID].isOwner;
    }
    await writeRegistry(registry);
  } catch (err) {
    console.error('[Server] Error releasing ownership:', err.message);
  }
}

/**
 * Claim a notebook for this instance
 */
async function claimNotebook(notebookPath) {
  if (claimedNotebooks.has(notebookPath)) return;

  claimedNotebooks.add(notebookPath);

  try {
    const registry = await readRegistry();

    // Remove this notebook from any other instance that might have claimed it
    for (const [id, info] of Object.entries(registry.instances)) {
      if (id !== INSTANCE_ID && info.notebooks) {
        info.notebooks = info.notebooks.filter(n => n !== notebookPath);
      }
    }

    // Add to this instance
    if (registry.instances[INSTANCE_ID]) {
      if (!registry.instances[INSTANCE_ID].notebooks) {
        registry.instances[INSTANCE_ID].notebooks = [];
      }
      if (!registry.instances[INSTANCE_ID].notebooks.includes(notebookPath)) {
        registry.instances[INSTANCE_ID].notebooks.push(notebookPath);
      }
    }

    await writeRegistry(registry);
    console.error(`[Server] Claimed notebook: ${notebookPath}`);
  } catch (err) {
    console.error('[Server] Error claiming notebook:', err.message);
  }
}

/**
 * Handle large responses by saving to file if over threshold
 * @param {string} text - The response text
 * @param {string} description - Description for the filename (e.g., 'svg-source', 'dep-graph')
 * @returns {Promise<string>} - Original text if small, or summary with file path if large
 */
async function handleLargeResponse(text, description) {
  if (text.length <= LARGE_RESPONSE_THRESHOLD) {
    return text;
  }

  await mkdir(RESPONSES_DIR, { recursive: true });

  const timestamp = Date.now();
  const sanitizedDesc = description.replace(/[^a-z0-9-]/gi, '-').slice(0, 30);
  const filename = `${sanitizedDesc}-${timestamp}.txt`;
  const filepath = join(RESPONSES_DIR, filename);

  await writeFile(filepath, text);

  const preview = text.slice(0, 500);
  return `[Large response saved to file]
Path: ${filepath}
Size: ${text.length} chars

Preview:
${preview}...

[Use Read tool to view full content]`;
}

/**
 * Clean up old response files (older than 1 hour)
 */
async function cleanupOldResponses() {
  try {
    if (!existsSync(RESPONSES_DIR)) return;

    const { readdir, stat, unlink } = await import('fs/promises');
    const files = await readdir(RESPONSES_DIR);
    const oneHourAgo = Date.now() - (60 * 60 * 1000);

    for (const file of files) {
      const filepath = join(RESPONSES_DIR, file);
      try {
        const stats = await stat(filepath);
        if (stats.mtimeMs < oneHourAgo) {
          await unlink(filepath);
          console.error(`[Server] Cleaned up old response file: ${file}`);
        }
      } catch (err) {
        // Ignore individual file errors
      }
    }
  } catch (err) {
    console.error('[Server] Error cleaning up responses:', err.message);
  }
}


/**
 * Try to start HTTP server on a port, returns true if successful
 * Tests both IPv4 (0.0.0.0) to match actual server bind
 */
function tryHttpPort(port) {
  return new Promise((resolve) => {
    const testServer = http.createServer();
    testServer.once('error', () => {
      testServer.close();
      resolve(false);
    });
    testServer.once('listening', () => {
      testServer.close();
      resolve(true);
    });
    // Explicitly bind to 0.0.0.0 to match actual server configuration
    testServer.listen(port, '0.0.0.0');
  });
}

/**
 * Find available ports for HTTP and WebSocket servers
 */
async function findAvailablePorts() {
  for (let i = 0; i < PORT_RANGE; i++) {
    const httpPort = BASE_HTTP_PORT + i * 2;
    const wsPort = BASE_WS_PORT + i * 2;

    const httpAvailable = await tryHttpPort(httpPort);
    const wsAvailable = await tryHttpPort(wsPort);

    if (httpAvailable && wsAvailable) {
      return { httpPort, wsPort };
    }
  }
  throw new Error(`Could not find available ports in range ${BASE_HTTP_PORT}-${BASE_HTTP_PORT + PORT_RANGE * 2}`);
}

// Session storage
const sessions = new Map();
let currentSessionId = null;

// Connected browser clients: Map<WebSocket, { url, connectedAt, sessionId }>
const clients = new Map();

// The notebook this MCP instance has claimed (for multi-notebook scenarios)
let focusedNotebook = null;

// Pending requests (for bidirectional communication)
const pendingRequests = new Map();
let requestCounter = 0;

/**
 * Get a short identifier for a notebook URL
 */
function getNotebookId(url) {
  try {
    const parsed = new URL(url);
    // Return pathname without leading slash, or 'index' for root
    const path = parsed.pathname.replace(/^\//, '') || 'index';
    // Remove .html extension for cleaner display
    return path.replace(/\.html$/, '');
  } catch {
    return url;
  }
}

/**
 * Find a client by notebook identifier (URL, path, or index)
 * Returns { client, info } or null
 */
function findClient(notebook) {
  if (!notebook) {
    // No notebook specified - check if we have a focused notebook
    if (clients.size === 0) {
      return { error: 'No connected notebooks' };
    }
    if (clients.size === 1) {
      const [client, info] = clients.entries().next().value;
      return { client, info };
    }

    // Multiple clients - try to use focused notebook
    if (focusedNotebook) {
      // Search for the focused notebook
      for (const [client, info] of clients.entries()) {
        if (info.url === focusedNotebook || getNotebookId(info.url) === focusedNotebook) {
          return { client, info };
        }
      }
      // Focused notebook not connected anymore
      const list = Array.from(clients.values())
        .map((info, i) => `  ${i}: ${getNotebookId(info.url)}`)
        .join('\n');
      return { error: `Focused notebook "${focusedNotebook}" is no longer connected. Use FocusNotebook to select one:\n${list}` };
    }

    // Multiple clients, no focus set - require explicit selection
    const list = Array.from(clients.values())
      .map((info, i) => `  ${i}: ${getNotebookId(info.url)} (${info.url})`)
      .join('\n');
    return { error: `Multiple notebooks connected. Use FocusNotebook to select which one to work with:\n${list}` };
  }

  // Try to find by index (number)
  const index = parseInt(notebook, 10);
  if (!isNaN(index)) {
    const entries = Array.from(clients.entries());
    if (index >= 0 && index < entries.length) {
      const [client, info] = entries[index];
      return { client, info };
    }
    return { error: `Invalid notebook index: ${index}. ${clients.size} notebook(s) connected.` };
  }

  // Try to find by URL or notebook ID
  for (const [client, info] of clients.entries()) {
    if (info.url === notebook || getNotebookId(info.url) === notebook) {
      return { client, info };
    }
  }

  // Try partial match
  for (const [client, info] of clients.entries()) {
    if (info.url.includes(notebook) || getNotebookId(info.url).includes(notebook)) {
      return { client, info };
    }
  }

  const list = Array.from(clients.values())
    .map((info, i) => `  ${i}: ${getNotebookId(info.url)}`)
    .join('\n');
  return { error: `Notebook "${notebook}" not found. Connected notebooks:\n${list}` };
}

// Server instances (created in main())
let httpServer = null;
let wss = null;

// Tool executor function (set after MCP handler is defined)
let executeToolCall = null;

/**
 * Create and start HTTP server for status/session endpoints
 */
function createHttpServer() {
  httpServer = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const notebooks = Array.from(clients.values()).map((info, i) => ({
        index: i,
        id: getNotebookId(info.url),
        url: info.url,
        connectedAt: info.connectedAt,
        sessionId: info.sessionId
      }));
      res.end(JSON.stringify({
        instanceId: INSTANCE_ID,
        currentSession: currentSessionId,
        sessions: Array.from(sessions.keys()),
        notebooks,
        claimedNotebooks: Array.from(claimedNotebooks),
        connectedClients: clients.size,
        ports: { http: HTTP_PORT, ws: WS_PORT }
      }));
    } else if (req.url.startsWith('/session/')) {
      const sessionId = req.url.slice(9);
      const session = sessions.get(sessionId);

      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session, null, 2));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
    } else if (req.url === '/mcp/call' && req.method === 'POST') {
      // Proxy endpoint for client instances to forward MCP tool calls
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { tool, args } = JSON.parse(body);

          if (!executeToolCall) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tool executor not initialized' }));
            return;
          }

          const result = await executeToolCall(tool, args || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return; // Don't fall through
    } else if (req.url === '/ping') {
      // Health check endpoint for client instances
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, instanceId: INSTANCE_ID, timestamp: Date.now() }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Debug Server Running\n');
    }
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.error(`[Server] HTTP server running on http://0.0.0.0:${HTTP_PORT}`);
  });
}

/**
 * Create and start WebSocket server for browser connections
 */
function createWebSocketServer() {
  wss = new WebSocketServer({
    host: '0.0.0.0',
    port: WS_PORT,
    perMessageDeflate: false  // Disable compression for faster connection handling
  });

  wss.on('connection', (ws) => {
    console.error('[Server] Client connected');
    // Initialize with unknown URL - will be updated on session_start
    clients.set(ws, { url: 'unknown', connectedAt: Date.now(), sessionId: null });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleBrowserMessage(message, ws);
      } catch (err) {
        console.error('[Server] Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      const info = clients.get(ws);
      console.error(`[Server] Client disconnected: ${info?.url || 'unknown'}`);
      clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[Server] WebSocket error:', err);
    });
  });

  console.error(`[Server] WebSocket server running on ws://0.0.0.0:${WS_PORT}`);
}

/**
 * Handle messages from browser clients
 */
function handleBrowserMessage(message, ws) {
  const { type, sessionId, data, timestamp, requestId } = message;

  // Handle responses to our requests (new value-centric responses)
  if (type === 'value_response' || type === 'values_response' ||
      type === 'values_list_response' || type === 'metadata_response' ||
      type === 'cell_value_response' || type === 'cells_list_response' ||
      type === 'errors_response' || type === 'setinput_response' ||
      type === 'elementcontent_response' || type === 'dependencygraph_response' ||
      type === 'browser_eval_response' || type === 'mouse_response' ||
      type === 'keyboard_response' || type === 'runtime_eval_response') {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      pending.resolve(message);
    }
    return;
  }

  // Handle requests from WebSocket clients (for testing/non-MCP access)
  if (type === 'GetValue' || type === 'GetValues' || type === 'ListValues' ||
      type === 'GetValueMetadata' || type === 'GetCellValue' || type === 'ListCells') {
    const responseTypes = {
      'GetValue': 'value_response',
      'GetValues': 'values_response',
      'ListValues': 'values_list_response',
      'GetValueMetadata': 'metadata_response',
      'GetCellValue': 'cell_value_response',
      'ListCells': 'cells_list_response'
    };
    const responseType = responseTypes[type];

    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      ws.send(JSON.stringify({
        type: responseType,
        requestId,
        success: false,
        error: 'Request timeout'
      }));
    }, 5000);

    pendingRequests.set(requestId, {
      resolve: (response) => {
        ws.send(JSON.stringify(response));
      },
      reject: () => {},
      timer: timeout
    });

    // Broadcast to all OTHER clients (browsers)
    const broadcastMsg = JSON.stringify(message);
    for (const [client] of clients) {
      if (client !== ws && client.readyState === 1) {
        client.send(broadcastMsg);
      }
    }
    return;
  }

  // Handle session start - update client info with URL
  if (type === 'session_start') {
    currentSessionId = sessionId;

    // Update client info with URL from session start
    const clientInfo = clients.get(ws);
    if (clientInfo && data?.url) {
      // Close any existing connections from the same URL (stale connections from page refresh)
      for (const [existingWs, existingInfo] of clients.entries()) {
        if (existingWs !== ws && existingInfo.url === data.url) {
          console.error(`[Server] Closing stale connection for ${getNotebookId(data.url)}`);
          try { existingWs.close(); } catch (e) {}
          clients.delete(existingWs);
        }
      }

      clientInfo.url = data.url;
      clientInfo.sessionId = sessionId;
      console.error(`[Server] Notebook connected: ${getNotebookId(data.url)} (${data.url})`);

      // Claim this notebook for this instance
      const notebookPath = getNotebookId(data.url);
      claimNotebook(notebookPath).catch(err => {
        console.error('[Server] Failed to claim notebook:', err.message);
      });
    }

    const existing = sessions.get(sessionId);
    if (existing) {
      existing.startTime = timestamp;
      console.error(`[Server] Session started (merged): ${sessionId}`);
    } else {
      sessions.set(sessionId, {
        id: sessionId,
        startTime: timestamp,
        logs: [],
        errors: [],
        binary: [],
        ended: false
      });
      console.error(`[Server] Session started: ${sessionId}`);
    }
    return;
  }

  // Get or create session
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      startTime: timestamp,
      logs: [],
      errors: [],
      binary: [],
      ended: false
    };
    sessions.set(sessionId, session);
    currentSessionId = sessionId;
  }

  // Handle different message types
  switch (type) {
    case 'log':
      session.logs.push({ timestamp, level: data.level, args: data.args });
      break;

    case 'error':
      session.errors.push({
        timestamp,
        message: data.message,
        stack: data.stack,
        source: data.source
      });
      break;

    case 'runtime_error':
      session.errors.push({
        timestamp,
        message: data.message,
        cellId: data.cellId,
        source: 'observable-runtime'
      });
      break;

    case 'vite_error':
      session.errors.push({
        timestamp,
        message: data.message,
        stack: data.stack || null,
        frame: data.frame || null,
        loc: data.loc || null,
        plugin: data.plugin || null,
        file: data.file || data.id || null,
        source: 'vite-build'
      });
      console.error(`[Server] Vite build error: ${data.message}`);
      break;

    case 'binary':
      session.binary.push({
        timestamp,
        name: data.name,
        type: data.mimeType,
        data: data.data
      });
      break;

    case 'session_end':
      session.ended = true;
      console.error(`[Server] Session ended: ${sessionId}`);
      break;
  }
}

/**
 * Create a request to browser and wait for response
 * @param {string} type - Message type
 * @param {object} data - Message data
 * @param {number} timeout - Timeout in ms
 * @param {string} notebook - Optional notebook identifier (URL, path, or index)
 */
function createRequest(type, data, timeout = DEFAULT_TIMEOUT, notebook = null) {
  const requestId = `req-${++requestCounter}`;

  return new Promise((resolve, reject) => {
    // Find the target client
    const result = findClient(notebook);
    if (result.error) {
      reject(new Error(result.error));
      return;
    }

    const { client } = result;

    if (client.readyState !== 1) {
      reject(new Error('Notebook client not ready'));
      return;
    }

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timer });

    const message = JSON.stringify({ type, requestId, ...data });
    client.send(message);
  });
}

/**
 * Request a single value from browser
 */
async function requestValue(name, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetValue', { name }, timeout, notebook);
}

/**
 * Request multiple/all values from browser
 */
async function requestValues(names, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetValues', { names }, timeout, notebook);
}

/**
 * Request list of values from browser
 */
async function requestValuesList(timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('ListValues', {}, timeout, notebook);
}

/**
 * Request value metadata from browser
 */
async function requestValueMetadata(name, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetValueMetadata', { name, label: name }, timeout, notebook);
}

/**
 * Request errors from browser
 */
async function requestErrors(verbose = false, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetErrors', { verbose }, timeout, notebook);
}

/**
 * Request to set an input value in browser
 */
async function requestSetInput(name, value, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('SetInput', { name, value, label: name }, timeout, notebook);
}

/**
 * Request element content from browser
 */
async function requestElementContent(selector, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetElementContent', { selector }, timeout, notebook);
}

/**
 * Request dependency graph from browser
 */
async function requestDependencyGraph(filters = {}, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetDependencyGraph', { filters }, timeout, notebook);
}

/**
 * Request JavaScript code execution in browser context (outside Observable runtime)
 */
async function requestBrowserEval(code, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('BrowserEval', { code }, timeout, notebook);
}

/**
 * Request mouse click in browser
 */
async function requestMouseClick(params, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('MouseClick', params, timeout, notebook);
}

/**
 * Request mouse drag in browser
 */
async function requestMouseDrag(params, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('MouseDrag', params, timeout, notebook);
}

/**
 * Request mouse wheel in browser
 */
async function requestMouseWheel(params, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('MouseWheel', params, timeout, notebook);
}

/**
 * Request mouse hover in browser
 */
async function requestMouseHover(params, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('MouseHover', params, timeout, notebook);
}

/**
 * Request keyboard input in browser
 */
async function requestSendKeys(keys, selector, modifiers, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('SendKeys', { keys, selector, modifiers, label: keys }, timeout, notebook);
}

/**
 * Evaluate an expression in the Observable runtime context
 * @param {string} name - Variable name (if starts with _tmp_, browser will delete after resolution)
 * @param {string} body - Function body (must use return statement)
 * @param {number} timeout - Timeout in ms
 * @param {string} notebook - Target notebook
 */
async function requestRuntimeEval(name, body, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('RuntimeEval', { name, body, label: name }, timeout, notebook);
}

/**
 * Send refresh command to a specific notebook or all notebooks
 */
function sendRefresh(notebook = null) {
  const sessionId = `session-${Date.now()}`;
  const message = JSON.stringify({ type: 'Refresh', sessionId });

  if (notebook) {
    // Target specific notebook
    const result = findClient(notebook);
    if (result.error) {
      throw new Error(result.error);
    }
    const { client, info } = result;
    if (client.readyState === 1) {
      console.error(`[Server] Refreshing notebook: ${getNotebookId(info.url)}`);
      client.send(message);
    }
  } else {
    // Refresh all notebooks
    console.error(`[Server] Refreshing all notebooks (new session: ${sessionId})`);
    for (const [client, info] of clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  return sessionId;
}

/**
 * Send navigate command to navigate a notebook to a new URL
 */
function sendNavigate(url, notebook = null) {
  const sessionId = `session-${Date.now()}`;
  const message = JSON.stringify({ type: 'Navigate', sessionId, url });

  if (notebook) {
    // Target specific notebook
    const result = findClient(notebook);
    if (result.error) {
      throw new Error(result.error);
    }
    const { client, info } = result;
    if (client.readyState === 1) {
      console.error(`[Server] Navigating notebook ${getNotebookId(info.url)} to: ${url}`);
      client.send(message);
    }
  } else {
    // Navigate all notebooks
    console.error(`[Server] Navigating all notebooks to: ${url} (new session: ${sessionId})`);
    for (const [client, info] of clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  return sessionId;
}

/**
 * Fetch session data
 */
async function fetchSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Wait for session completion
 */
async function waitForCompletion(sessionId, timeout) {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < timeout) {
    const session = await fetchSession(sessionId);

    if (session) {
      const completionLog = session.logs?.find(log =>
        log.args?.some(arg =>
          typeof arg === 'string' && arg.includes('[NOTEBOOK_READY]')
        )
      );

      if (completionLog) {
        return { completed: true, duration: Date.now() - startTime, session };
      }

      if (session.ended) {
        return { completed: true, duration: Date.now() - startTime, session };
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  const session = await fetchSession(sessionId);
  return { completed: false, duration: timeout, session };
}

/**
 * Format session output for display
 * @param {Object} session - The session object
 * @param {string} filter - Optional filter string
 * @param {number} maxChars - Maximum output length (0 for unlimited)
 */
function formatSessionOutput(session, filter, maxChars = 2000) {
  if (!session) {
    return 'No session data available';
  }

  const output = [];

  let filteredLogs = session.logs || [];
  if (filter) {
    filteredLogs = filteredLogs.filter(log => {
      const logText = log.args?.map(arg => {
        if (typeof arg === 'object') {
          return JSON.stringify(arg);
        }
        return String(arg);
      }).join(' ') || '';
      return logText.includes(filter);
    });
  }

  output.push(`Session: ${session.id}`);
  const startTime = session.startTime ? new Date(session.startTime).toISOString() : 'unknown';
  output.push(`Started: ${startTime}`);
  if (filter) {
    output.push(`Filter: "${filter}"`);
    output.push(`Logs: ${filteredLogs.length} (of ${session.logs?.length || 0} total)`);
  } else {
    output.push(`Logs: ${session.logs?.length || 0}`);
  }
  output.push(`Errors: ${session.errors?.length || 0}`);
  output.push('');

  if (filteredLogs.length > 0) {
    output.push('=== LOGS ===');
    filteredLogs.forEach(log => {
      const time = log.timestamp ? new Date(log.timestamp).toISOString().split('T')[1].slice(0, -1) : '??:??:??';
      const level = log.level.toUpperCase().padEnd(5);
      const args = log.args?.map(arg => {
        if (typeof arg === 'object') {
          return JSON.stringify(arg);
        }
        return String(arg);
      }).join(' ') || '';

      output.push(`[${time}] ${level} ${args}`);
    });
    output.push('');
  }

  if (session.errors && session.errors.length > 0) {
    output.push('=== ERRORS ===');
    session.errors.forEach(error => {
      const time = error.timestamp ? new Date(error.timestamp).toISOString().split('T')[1].slice(0, -1) : '??:??:??';
      const sourceTag = error.source ? ` [${error.source}]` : '';
      output.push(`[${time}] ERROR${sourceTag}: ${error.message}`);

      if (error.cellId) {
        output.push(`  Cell: ${error.cellId}`);
      }

      if (error.file) {
        output.push(`  File: ${error.file}`);
      }

      if (error.loc) {
        output.push(`  Location: line ${error.loc.line}, column ${error.loc.column}`);
      }

      if (error.frame) {
        output.push(`  Code:\n${error.frame.split('\n').map(l => '    ' + l).join('\n')}`);
      }

      if (error.stack) {
        output.push(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
      }

      output.push('');
    });
  }

  let result = output.join('\n');

  // Apply truncation if maxChars is set (non-zero)
  if (maxChars > 0 && result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n\n[OUTPUT TRUNCATED - ' + result.length + ' chars total, showing first ' + maxChars + '. Use max_chars parameter to adjust limit or filter to narrow results.]';
  }

  return result;
}

/**
 * Format console messages for GetConsoleMessages tool
 * @param {Object} session - The session object
 * @param {string} channel - Optional channel filter ('log', 'info', 'warn', 'error')
 * @param {string} filter - Optional substring filter
 * @param {number} maxChars - Maximum output length (0 for unlimited)
 */
function formatConsoleMessages(session, channel, filter, maxChars = 2000) {
  if (!session) {
    return 'No session data available';
  }

  let logs = session.logs || [];

  // Filter by channel if specified
  if (channel) {
    logs = logs.filter(log => log.level === channel);
  }

  // Filter by substring if specified
  if (filter) {
    logs = logs.filter(log => {
      const logText = log.args?.map(arg => {
        if (typeof arg === 'object') {
          return JSON.stringify(arg);
        }
        return String(arg);
      }).join(' ') || '';
      return logText.includes(filter);
    });
  }

  const output = [];
  output.push(`Session: ${session.id}`);

  const channelInfo = channel ? ` (channel: ${channel})` : ' (all channels)';
  const filterInfo = filter ? `, filter: "${filter}"` : '';
  output.push(`Messages: ${logs.length}${channelInfo}${filterInfo}`);
  output.push('');

  if (logs.length === 0) {
    output.push('No messages found.');
  } else {
    logs.forEach(log => {
      const time = log.timestamp ? new Date(log.timestamp).toISOString().split('T')[1].slice(0, -1) : '??:??:??';
      const level = log.level.toUpperCase().padEnd(5);
      const args = log.args?.map(arg => {
        if (typeof arg === 'object') {
          return JSON.stringify(arg);
        }
        return String(arg);
      }).join(' ') || '';

      output.push(`[${time}] ${level} ${args}`);
    });
  }

  let result = output.join('\n');

  // Apply truncation if maxChars is set (non-zero)
  if (maxChars > 0 && result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n\n[OUTPUT TRUNCATED - ' + result.length + ' chars total, showing first ' + maxChars + '. Use max_chars parameter to adjust limit, channel to filter by level, or filter to narrow results.]';
  }

  return result;
}

/**
 * Format a value response with state information
 */
function formatValueResponse(response) {
  const { name, state, value, error, stack } = response;

  const output = [`Value: ${name}`, `State: ${state}`];

  if (state === 'fulfilled') {
    output.push('');
    output.push(formatValue(value));
  } else if (state === 'rejected') {
    output.push(`Error: ${error}`);
    if (stack) {
      output.push(`Stack: ${stack.split('\n').slice(0, 3).join('\n  ')}`);
    }
  } else if (state === 'pending') {
    output.push('(Value is still computing)');
  }

  return output.join('\n');
}

/**
 * Format a serialized value for display
 */
function formatValue(value) {
  if (value === null) return 'null';
  if (value === undefined || value?.__type === 'undefined') return 'undefined';

  if (value?.__type) {
    switch (value.__type) {
      case 'Function':
        return `Function: ${value.name}\n${value.source}`;
      case 'Error':
        return `Error: ${value.message}\n${value.stack || ''}`;
      case 'Canvas':
        if (value.data) {
          return `Canvas (${value.width}x${value.height})\nBase64 data: ${value.data.slice(0, 100)}...`;
        }
        return `Canvas (${value.width}x${value.height})\n${value.error || ''}`;
      case 'Element':
        return `Element: <${value.tagName}${value.id ? ' id="' + value.id + '"' : ''}${value.className ? ' class="' + value.className + '"' : ''}>\n${value.innerHTML}`;
      case 'TypedArray':
        return `${value.arrayType} (length: ${value.length})\nSample: [${value.sample.join(', ')}]${value.truncated ? '...' : ''}`;
      case 'Array':
        return `Array (length: ${value.length})\nSample:\n${JSON.stringify(value.sample, null, 2)}${value.truncated ? '\n...' : ''}`;
      case 'Date':
        return `Date: ${value.value}`;
      case 'RegExp':
        return `RegExp: /${value.source}/${value.flags}`;
      case 'Map':
        return `Map (size: ${value.size})\nEntries:\n${JSON.stringify(value.entries, null, 2)}${value.truncated ? '\n...' : ''}`;
      case 'Set':
        return `Set (size: ${value.size})\nValues:\n${JSON.stringify(value.values, null, 2)}${value.truncated ? '\n...' : ''}`;
      case 'Circular':
        return `[Circular: ${value.ref}]`;
      case 'MaxDepthExceeded':
        return '[Max depth exceeded]';
      case 'string':
        return value.truncated ? `"${value.value}" (truncated, ${value.length} chars total)` : value.value;
    }
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }

  if (typeof value === 'object') {
    const str = JSON.stringify(value, null, 2);
    if (str.length > 5000) {
      return str.slice(0, 5000) + '\n...[truncated]';
    }
    return str;
  }

  return String(value);
}

/**
 * Format metadata for display
 */
function formatMetadata(metadata) {
  const output = [
    `Name: ${metadata.name}`,
    `State: ${metadata.state}`,
  ];

  if (metadata.valueType) {
    output.push(`Type: ${metadata.valueType}`);
  }

  if (metadata.inputs && metadata.inputs.length > 0) {
    output.push(`Dependencies: ${metadata.inputs.join(', ')}`);
  }

  if (metadata.outputs && metadata.outputs.length > 0) {
    output.push(`Dependents: ${metadata.outputs.join(', ')}`);
  }

  if (metadata.error) {
    output.push(`Error: ${metadata.error}`);
  }

  return output.join('\n');
}

// Create MCP server
const server = new Server(
  {
    name: 'debug-notebook',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Common notebook parameter for all tools
const notebookParam = {
  type: 'string',
  description: 'Target notebook (URL, path like "index" or "voronoi", or index like "0"). Optional if you\'ve used FocusNotebook or only one notebook is connected.'
};

// Common label parameter for all tools
const labelParam = {
  type: 'string',
  description: 'Optional label describing the intent of this action (e.g., "expand plot", "zoom in"). Displayed in the notebook\'s event log overlay.'
};

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'ListNotebooks',
        description: 'List all connected notebooks. Use this to see which notebooks are available before targeting a specific one.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'FocusNotebook',
        description: 'Focus on a specific notebook. When multiple notebooks are connected, this sets which one receives commands by default. Use ListNotebooks to see available options.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: {
              type: 'string',
              description: 'Target notebook (URL, path like "index" or "voronoi", or index like "0")'
            }
          },
          required: ['notebook']
        }
      },
      {
        name: 'Refresh',
        description: 'Trigger notebook page refresh and wait for completion. Captures all logs and errors from the new session.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            wait_for_completion: {
              type: 'boolean',
              description: 'Wait for session_end signal (recommended)',
              default: true
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: COMPLETION_TIMEOUT
            }
          }
        }
      },
      {
        name: 'Navigate',
        description: 'Navigate a notebook to a different URL, or open a URL in the default browser if no notebooks are connected. If a notebook is connected, navigates that browser window to the new URL. If no notebooks are connected, opens the URL in the OS default browser. Useful for switching between notebooks (e.g., from localhost:5173/notebooks/notebook-a to localhost:5173/notebooks/notebook-b) or opening a notebook for the first time.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to navigate to (can be relative like "/notebooks/notebook-b" or absolute like "http://localhost:5173/notebooks/notebook-b")'
            },
            notebook: notebookParam,
            wait_for_completion: {
              type: 'boolean',
              description: 'Wait for session_end signal (recommended when navigating existing notebook)',
              default: true
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: COMPLETION_TIMEOUT
            }
          },
          required: ['url']
        }
      },
      {
        name: 'ListValues',
        description: 'List all named values in the Observable runtime\'s reactive graph.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'GetValue',
        description: 'Get a value from the Observable runtime by name. Returns the value along with its state (fulfilled, pending, or rejected). Automatically returns image content for Canvas and SVG elements.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            name: {
              type: 'string',
              description: 'Name of the value to retrieve'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait for the value to resolve',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['name']
        }
      },
      {
        name: 'GetValues',
        description: 'Get multiple values from the Observable runtime at once. If no names provided, returns all values. Useful for getting a snapshot of the runtime state.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of values to retrieve (omit for all values)'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait per value',
              default: 100
            }
          }
        }
      },
      {
        name: 'GetValueMetadata',
        description: 'Get metadata about a value in the Observable runtime including its state, type, dependencies (inputs), and dependents (outputs) without fetching the full value.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            name: {
              type: 'string',
              description: 'Name of the value'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['name']
        }
      },
      {
        name: 'GetConsoleMessages',
        description: 'Get console messages (log, info, warn, error) from the current or most recent session. Use this to debug console output without triggering a refresh.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Specific session ID (optional, uses current session if not provided)'
            },
            channel: {
              type: 'string',
              enum: ['log', 'info', 'warn', 'error'],
              description: 'Filter to a specific console channel. If omitted, returns all channels.'
            },
            filter: {
              type: 'string',
              description: 'Filter messages by substring match'
            },
            max_chars: {
              type: 'number',
              description: 'Maximum output length in characters (default: 2000). Set to 0 for unlimited.',
              default: 2000
            }
          }
        }
      },
      {
        name: 'GetErrors',
        description: 'Get errors from the notebook. Returns both Vite build/parse errors (e.g. syntax errors that prevent the page from loading) and Observable runtime errors (values in a rejected state). If the page fails to load due to a syntax error, call this first — it will surface the Vite error even without a connected runtime. For console.error messages, use GetConsoleMessages with channel="error".',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            verbose: {
              type: 'boolean',
              description: 'Include full stack traces (default: false)',
              default: false
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'SetInputValue',
        description: 'Set the .value property of an input widget in the Observable runtime (e.g., Inputs.range, Inputs.select, Inputs.text) and dispatch an input event, triggering reactive updates to dependent values.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            name: {
              type: 'string',
              description: 'Name of the cell containing the input widget (e.g., "slider" if defined as `slider = Inputs.range([0, 100])`)'
            },
            value: {
              description: 'The value to set (number for range, string for text/select, boolean for toggle, array of strings for checkbox)'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['name', 'value']
        }
      },
      {
        name: 'GetElementContent',
        description: 'Get content from a DOM element by CSS selector. Auto-detects element type: returns text/HTML for regular elements, returns image content for canvas/SVG elements.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            selector: {
              type: 'string',
              description: 'CSS selector for the element (e.g., "#cell-31", ".my-class", "svg.chart")'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['selector']
        }
      },
      {
        name: 'GetDependencyGraph',
        description: 'Get the dependency graph from the Observable runtime showing how values depend on each other. Returns nodes (values) and edges (dependencies).',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            name: {
              type: 'string',
              description: 'Focus on a specific node - shows its upstream dependencies and/or downstream dependents'
            },
            pattern: {
              type: 'string',
              description: 'Filter nodes by name pattern (supports * wildcard, e.g., "chain*", "*Error")'
            },
            direction: {
              type: 'string',
              enum: ['both', 'upstream', 'downstream'],
              description: 'When using "name" filter: "upstream" shows dependencies, "downstream" shows dependents, "both" shows all connected nodes',
              default: 'both'
            },
            depth: {
              type: 'number',
              description: 'Maximum depth to traverse when using "name" filter (default: unlimited)',
              default: -1
            },
            include_anonymous: {
              type: 'boolean',
              description: 'Include anonymous values (cell 1, cell 2, etc.) in output. These are intermediate values from cells without named exports. Default false to reduce noise.',
              default: false
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'BrowserEval',
        description: 'Execute JavaScript in the browser context. Has access to the DOM but NOT the Observable runtime. Use RuntimeEval instead when you need access to notebook variables. Useful for DOM inspection, computed styles, or browser APIs.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            label: labelParam,
            code: {
              type: 'string',
              description: 'JavaScript code to execute. The result of the last expression is returned.'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['code']
        }
      },
      {
        name: 'MouseClick',
        description: 'Simulate a mouse click at a position. Can target a specific element or coordinates.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            label: labelParam,
            selector: {
              type: 'string',
              description: 'CSS selector for target element. If provided, position is relative to element.'
            },
            x: {
              type: 'number',
              description: 'X coordinate (relative to element if selector provided, otherwise viewport)'
            },
            y: {
              type: 'number',
              description: 'Y coordinate (relative to element if selector provided, otherwise viewport)'
            },
            button: {
              type: 'number',
              description: 'Mouse button (0=left, 1=middle, 2=right). Default: 0',
              default: 0
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'MouseDrag',
        description: 'Simulate a mouse drag from start to end position. Emits mousedown, mousemove events per animation frame, then mouseup.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            label: labelParam,
            selector: {
              type: 'string',
              description: 'CSS selector for target element. If provided, positions are relative to element.'
            },
            startX: {
              type: 'number',
              description: 'Starting X coordinate',
              default: 0
            },
            startY: {
              type: 'number',
              description: 'Starting Y coordinate',
              default: 0
            },
            endX: {
              type: 'number',
              description: 'Ending X coordinate',
              default: 0
            },
            endY: {
              type: 'number',
              description: 'Ending Y coordinate',
              default: 0
            },
            duration: {
              type: 'number',
              description: 'Duration of drag in milliseconds. Default: 300',
              default: 300
            },
            button: {
              type: 'number',
              description: 'Mouse button (0=left, 1=middle, 2=right). Default: 0',
              default: 0
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'MouseWheel',
        description: 'Simulate a mouse wheel scroll at a position.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            label: labelParam,
            selector: {
              type: 'string',
              description: 'CSS selector for target element. If provided, position is relative to element.'
            },
            x: {
              type: 'number',
              description: 'X coordinate (relative to element if selector provided, otherwise viewport)'
            },
            y: {
              type: 'number',
              description: 'Y coordinate (relative to element if selector provided, otherwise viewport)'
            },
            duration: {
              type: 'number',
              description: 'Duration of scroll animation in milliseconds. Default: 300',
              default: 300
            },
            deltaX: {
              type: 'number',
              description: 'Horizontal scroll amount. Default: 0',
              default: 0
            },
            deltaY: {
              type: 'number',
              description: 'Vertical scroll amount (positive = scroll down). Default: 0',
              default: 0
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'MouseHover',
        description: 'Simulate mouse hover at a position. Dispatches mouseenter, mouseover, and mousemove events to trigger hover states and tooltips.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            label: labelParam,
            selector: {
              type: 'string',
              description: 'CSS selector for target element. If provided, position is relative to element.'
            },
            x: {
              type: 'number',
              description: 'X coordinate (relative to element if selector provided, otherwise viewport)'
            },
            y: {
              type: 'number',
              description: 'Y coordinate (relative to element if selector provided, otherwise viewport)'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'SendKeys',
        description: 'Simulate keyboard input. Dispatches keydown, keypress (for printable characters), and keyup events to the target element.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            keys: {
              type: 'string',
              description: 'Keys to send. Plain characters are sent as-is. Special keys use braces: {Enter}, {Tab}, {Escape}, {Backspace}, {Delete}, {ArrowUp}, {ArrowDown}, {ArrowLeft}, {ArrowRight}, {Space}, {Home}, {End}, {F1}-{F12}. Modifier combos: {Ctrl+a}, {Shift+Tab}, {Meta+s}.'
            },
            selector: {
              type: 'string',
              description: 'CSS selector for target element. If not provided, sends to the currently focused element.'
            },
            modifiers: {
              type: 'object',
              description: 'Modifier keys to hold during all keystrokes',
              properties: {
                ctrlKey: { type: 'boolean', description: 'Hold Ctrl key' },
                altKey: { type: 'boolean', description: 'Hold Alt key' },
                shiftKey: { type: 'boolean', description: 'Hold Shift key' },
                metaKey: { type: 'boolean', description: 'Hold Meta/Cmd key' }
              }
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['keys']
        }
      },
      {
        name: 'RuntimeEval',
        description: 'Evaluate an expression in the Observable runtime context, with access to all notebook variables. Must use a return statement. Prefer this over Eval when computing derived values from runtime state. Examples: "return a + b" computes a sum; "return data.filter(d => d.value > 0)" filters a dataset.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            body: {
              type: 'string',
              description: 'JavaScript code to evaluate. Must use "return" to produce a result. All notebook variables are accessible.'
            },
            name: {
              type: 'string',
              description: 'If provided, the result persists in the runtime as a named variable for subsequent GetValue queries. If omitted, the result is returned and discarded.'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait for the value to resolve (default: 10 seconds)',
              default: 10000
            }
          },
          required: ['body']
        }
      }
    ]
  };
});

/**
 * Execute a tool call - shared between MCP handler and HTTP proxy
 */
async function handleToolExecution(name, args) {
  try {
    if (name === 'ListNotebooks') {
      if (clients.size === 0) {
        return {
          content: [{
            type: 'text',
            text: `No notebooks connected to this instance (${INSTANCE_ID}).\n\nMake sure your notebook is running with the debug plugin enabled.`
          }]
        };
      }

      const notebooks = Array.from(clients.values()).map((info, i) => {
        const id = getNotebookId(info.url);
        const connectedAgo = Math.round((Date.now() - info.connectedAt) / 1000);
        return `${i}: ${id}\n   URL: ${info.url}\n   Connected: ${connectedAgo}s ago`;
      });

      const focusInfo = focusedNotebook ? `\nFocused: ${focusedNotebook}` : '\nNo notebook focused (use FocusNotebook if needed)';
      return {
        content: [{
          type: 'text',
          text: `Instance: ${INSTANCE_ID}${focusInfo}\nConnected notebooks (${clients.size}):\n\n${notebooks.join('\n\n')}`
        }]
      };
    }

    if (name === 'FocusNotebook') {
      const { notebook } = args;

      if (!notebook) {
        return {
          content: [{ type: 'text', text: 'Error: notebook is required' }],
          isError: true
        };
      }

      // Verify the notebook exists
      const result = findClient(notebook);
      if (result.error && !result.error.includes('Multiple notebooks')) {
        // The notebook wasn't found
        return {
          content: [{ type: 'text', text: result.error }],
          isError: true
        };
      }

      // Find the actual notebook ID to store
      let targetNotebook = notebook;
      for (const [client, info] of clients.entries()) {
        const id = getNotebookId(info.url);
        if (info.url === notebook || id === notebook || info.url.includes(notebook) || id.includes(notebook)) {
          targetNotebook = id;
          focusedNotebook = id;

          // Also claim this notebook in the registry
          claimNotebook(id).catch(err => {
            console.error('[Server] Failed to claim notebook:', err.message);
          });

          return {
            content: [{
              type: 'text',
              text: `Focused on notebook: ${id}\nURL: ${info.url}\n\nAll subsequent commands will target this notebook.`
            }]
          };
        }
      }

      // Try by index
      const index = parseInt(notebook, 10);
      if (!isNaN(index)) {
        const entries = Array.from(clients.entries());
        if (index >= 0 && index < entries.length) {
          const [client, info] = entries[index];
          const id = getNotebookId(info.url);
          focusedNotebook = id;

          claimNotebook(id).catch(err => {
            console.error('[Server] Failed to claim notebook:', err.message);
          });

          return {
            content: [{
              type: 'text',
              text: `Focused on notebook: ${id}\nURL: ${info.url}\n\nAll subsequent commands will target this notebook.`
            }]
          };
        }
      }

      return {
        content: [{ type: 'text', text: `Notebook "${notebook}" not found` }],
        isError: true
      };
    }

    if (name === 'Refresh') {
      const { notebook, wait_for_completion, timeout_ms } = args || {};
      const waitForSignal = wait_for_completion !== false;
      const timeout = timeout_ms || (waitForSignal ? COMPLETION_TIMEOUT : 5000);

      const sessionId = sendRefresh(notebook);
      const result = await waitForCompletion(sessionId, timeout);

      const session = result.session;
      const uncaughtCount = session?.errors?.length || 0;
      const logCount = session?.logs?.length || 0;

      const statusText = result.completed
        ? `Notebook refreshed in ${result.duration}ms`
        : `Timeout after ${result.duration}ms`;

      const output = [statusText];

      if (uncaughtCount > 0) {
        output.push(`Uncaught exceptions: ${uncaughtCount}`);
        session.errors.forEach(error => {
          output.push(`  - ${error.message}${error.cellId ? ` (cell: ${error.cellId})` : ''}`);
        });
      } else {
        output.push('No uncaught exceptions');
      }

      output.push(`Console messages: ${logCount} (use GetConsoleMessages to view)`);
      output.push(`(Use GetErrors for runtime rejected values)`);

      return {
        content: [{
          type: 'text',
          text: output.join('\n')
        }]
      };
    }

    if (name === 'Navigate') {
      const { url, notebook, wait_for_completion, timeout_ms } = args || {};

      if (!url) {
        return {
          content: [{ type: 'text', text: 'Error: url is required' }],
          isError: true
        };
      }

      // If no notebooks are connected, open the URL in the OS default browser
      if (clients.size === 0) {
        try {
          const open = (await import('open')).default;
          await open(url);

          return {
            content: [{
              type: 'text',
              text: `No notebooks connected. Opened URL in default browser:\n${url}\n\nOnce the page loads with the debug plugin enabled, it will connect automatically.`
            }]
          };
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: `Error opening URL in browser: ${err.message}\n\nNo notebooks are connected. Please open the URL manually:\n${url}`
            }],
            isError: true
          };
        }
      }

      const waitForSignal = wait_for_completion !== false;
      const timeout = timeout_ms || (waitForSignal ? COMPLETION_TIMEOUT : 5000);

      const sessionId = sendNavigate(url, notebook);

      if (!waitForSignal) {
        return {
          content: [{
            type: 'text',
            text: `Navigation command sent to: ${url}\nSession ID: ${sessionId}\n\nNot waiting for completion (wait_for_completion=false).`
          }]
        };
      }

      const result = await waitForCompletion(sessionId, timeout);

      const session = result.session;
      const uncaughtCount = session?.errors?.length || 0;
      const logCount = session?.logs?.length || 0;

      const statusText = result.completed
        ? `Navigated to ${url} in ${result.duration}ms`
        : `Navigation timed out after ${result.duration}ms\n\nThis usually means:\n- The target page doesn't have the debug plugin enabled\n- The URL is invalid or the page failed to load\n- The page took longer than ${timeout}ms to initialize\n\nTry setting wait_for_completion=false if you just want to trigger navigation.`;

      const output = [statusText];

      if (result.completed) {
        if (uncaughtCount > 0) {
          output.push(`\nUncaught exceptions: ${uncaughtCount}`);
          session.errors.forEach(error => {
            output.push(`  - ${error.message}${error.cellId ? ` (cell: ${error.cellId})` : ''}`);
          });
        } else {
          output.push('\nNo uncaught exceptions');
        }

        output.push(`Console messages: ${logCount} (use GetConsoleMessages to view)`);
        output.push(`(Use GetErrors for runtime rejected values)`);
      }

      return {
        content: [{
          type: 'text',
          text: output.join('\n')
        }]
      };
    }

    if (name === 'ListValues') {
      const { notebook, timeout_ms = DEFAULT_TIMEOUT } = args || {};

      const response = await requestValuesList(timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      const valueList = response.values.join('\n- ');
      return {
        content: [{
          type: 'text',
          text: `Available values (${response.values.length}):\n\n- ${valueList}`
        }]
      };
    }

    if (name === 'GetValue') {
      const { notebook, name: valueName, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!valueName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      const response = await requestValue(valueName, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      // Return image content block for Canvas/SVG with image data
      const value = response.value;
      if (response.state === 'fulfilled' && value?.__type === 'Canvas' && value.data) {
        return {
          content: [
            { type: 'text', text: `Value: ${valueName}\nState: fulfilled\nCanvas: ${value.width}x${value.height}` },
            { type: 'image', data: value.data, mimeType: 'image/png' }
          ]
        };
      }

      if (response.state === 'fulfilled' && value?.__type === 'SVG' && value.data) {
        return {
          content: [
            { type: 'text', text: `Value: ${valueName}\nState: fulfilled\nSVG: ${value.width}x${value.height}` },
            { type: 'image', data: value.data, mimeType: 'image/png' }
          ]
        };
      }

      const valueOutput = await handleLargeResponse(formatValueResponse(response), `value-${valueName}`);
      return {
        content: [{
          type: 'text',
          text: valueOutput
        }]
      };
    }

    if (name === 'GetValues') {
      const { notebook, names, timeout_ms = 100 } = args || {};

      const response = await requestValues(names, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      const entries = Object.entries(response.values);
      const output = [`Values (${entries.length}):\n`];

      for (const [name, data] of entries) {
        output.push(`## ${name}`);
        output.push(`State: ${data.state}`);
        if (data.state === 'fulfilled') {
          const formatted = formatValue(data.value);
          // Truncate long values in bulk output
          if (formatted.length > 200) {
            output.push(formatted.slice(0, 200) + '...');
          } else {
            output.push(formatted);
          }
        } else if (data.state === 'rejected') {
          output.push(`Error: ${data.error}`);
        }
        output.push('');
      }

      const valuesOutput = await handleLargeResponse(output.join('\n'), 'values-bulk');
      return {
        content: [{
          type: 'text',
          text: valuesOutput
        }]
      };
    }

    if (name === 'GetValueMetadata') {
      const { notebook, name: valueName, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!valueName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      const response = await requestValueMetadata(valueName, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: formatMetadata(response.metadata)
        }]
      };
    }

    if (name === 'GetConsoleMessages') {
      const { session_id, channel, filter, max_chars = 2000 } = args || {};

      const sessionId = session_id || currentSessionId;

      if (!sessionId) {
        return {
          content: [{
            type: 'text',
            text: 'No active session found'
          }]
        };
      }

      const session = await fetchSession(sessionId);

      return {
        content: [{
          type: 'text',
          text: formatConsoleMessages(session, channel, filter, max_chars)
        }]
      };
    }

     if (name === 'GetErrors') {
       const { notebook, verbose = false, timeout_ms = DEFAULT_TIMEOUT } = args || {};

       const outputParts = [];

       // Check for Vite build errors stored in the current session.
       // These are captured even when the Observable runtime fails to start.
       const viteErrors = currentSessionId
         ? (sessions.get(currentSessionId)?.errors || []).filter(e => e.source === 'vite-build')
         : [];

       if (viteErrors.length > 0) {
         const viteSection = viteErrors.map(e => {
           const lines = [`[vite-build] ${e.message}`];
           if (e.file) lines.push(`  File: ${e.file}`);
           if (e.loc) lines.push(`  Location: line ${e.loc.line}, column ${e.loc.column}`);
           if (e.frame) lines.push(`  Code:\n${e.frame.split('\n').map(l => '    ' + l).join('\n')}`);
           if (verbose && e.stack) lines.push(`  Stack:\n${e.stack.split('\n').slice(0, 6).map(l => '    ' + l).join('\n')}`);
           return lines.join('\n');
         }).join('\n\n---\n\n');
         outputParts.push(`=== VITE BUILD ERROR${viteErrors.length > 1 ? 'S' : ''} ===\n\n${viteSection}`);
       }

       // Also try to get runtime errors from the browser (may timeout if runtime didn't start).
       let runtimeErrorText = null;
       try {
         const response = await requestErrors(verbose, timeout_ms, notebook);
         if (response.success && response.errors.length > 0) {
           const errorList = response.errors.map(e => {
             let msg = `Value: ${e.name}\nError: ${e.error}`;
             if (verbose && e.stack) {
               const stackLines = e.stack.split('\n').slice(0, 6).join('\n');
               msg += `\nStack:\n${stackLines}`;
             }
             return msg;
           }).join('\n\n---\n\n');
           runtimeErrorText = `=== RUNTIME ERRORS ===\n\nFound ${response.errors.length} error(s):\n\n${errorList}`;
         } else if (!response.success && viteErrors.length === 0) {
           // No vite errors either — surface the connection error
           return {
             content: [{ type: 'text', text: `Error: ${response.error}` }],
             isError: true
           };
         }
       } catch (err) {
         // Runtime request timed out — likely because the runtime didn't start.
         // If we have vite errors, that explains why; otherwise mention the timeout.
         if (viteErrors.length === 0) {
           outputParts.push(`Note: Runtime error request timed out (${err.message}). The Observable runtime may not have started.`);
         }
       }

       if (runtimeErrorText) {
         outputParts.push(runtimeErrorText);
       }

       if (outputParts.length === 0) {
         return {
           content: [{ type: 'text', text: 'No errors found in notebook.' }]
         };
       }

       return {
         content: [{
           type: 'text',
           text: outputParts.join('\n\n')
         }]
       };
     }

    if (name === 'SetInputValue') {
      const { notebook, name: valueName, value, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!valueName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      if (value === undefined) {
        return {
          content: [{ type: 'text', text: 'Error: value is required' }],
          isError: true
        };
      }

      const response = await requestSetInput(valueName, value, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      const output = [`Set "${valueName}" to ${JSON.stringify(value)}`];

      if (response.previousValue !== undefined) {
        output.push(`Previous value: ${JSON.stringify(response.previousValue)}`);
      }

      if (response.newValue !== undefined) {
        output.push(`New value: ${JSON.stringify(response.newValue)}`);
      }

      return {
        content: [{
          type: 'text',
          text: output.join('\n')
        }]
      };
    }

    if (name === 'GetElementContent') {
      const { notebook, selector, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!selector) {
        return {
          content: [{ type: 'text', text: 'Error: selector is required' }],
          isError: true
        };
      }

      const response = await requestElementContent(selector, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      const content = [];
      const textOutput = [];
      textOutput.push(`Element: ${response.tagName} (${selector})`);

      if (response.elementType) {
        textOutput.push(`Type: ${response.elementType}`);
      }

      // Handle image data - return as image content block
      if (response.imageData) {
        textOutput.push(`Image: ${response.width}x${response.height}`);
        content.push({ type: 'text', text: textOutput.join('\n') });
        content.push({ type: 'image', data: response.imageData, mimeType: 'image/png' });
      } else {
        // Handle text content (with large response handling)
        if (response.textContent !== undefined) {
          const textContent = await handleLargeResponse(response.textContent, `text-${selector}`);
          textOutput.push(`\nText content:\n${textContent}`);
        }

        // Handle innerHTML (with large response handling)
        if (response.innerHTML !== undefined) {
          const innerHTML = await handleLargeResponse(response.innerHTML, `html-${selector}`);
          textOutput.push(`\nHTML:\n${innerHTML}`);
        }

        // Handle SVG source (with large response handling)
        if (response.svgSource !== undefined) {
          const svgSource = await handleLargeResponse(response.svgSource, `svg-${selector}`);
          textOutput.push(`\nSVG source:\n${svgSource}`);
        }

        content.push({ type: 'text', text: textOutput.join('\n') });
      }

      return { content };
    }

    if (name === 'GetDependencyGraph') {
      const {
        notebook,
        name: filterName,
        pattern,
        direction = 'both',
        depth = -1,
        include_anonymous = false,
        timeout_ms = DEFAULT_TIMEOUT
      } = args || {};

      const filters = { name: filterName, pattern, direction, depth, include_anonymous };
      const response = await requestDependencyGraph(filters, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      const { nodes, edges } = response.graph;
      const output = [];

      // Build header with filter info
      output.push(`# Dependency Graph\n`);
      if (filterName) {
        output.push(`Filter: focused on "${filterName}" (${direction})`);
      } else if (pattern) {
        output.push(`Filter: pattern "${pattern}"`);
      }
      if (!include_anonymous) {
        output.push(`(anonymous values hidden, use include_anonymous=true to show)`);
      }
      output.push(`Nodes: ${nodes.length}`);
      output.push(`Edges: ${edges.length}\n`);

      // Group nodes by their dependency depth (roots first)
      const roots = nodes.filter(n => !n.inputs || n.inputs.length === 0);
      const nonRoots = nodes.filter(n => n.inputs && n.inputs.length > 0);

      if (roots.length > 0) {
        output.push(`## Root nodes (no dependencies)`);
        for (const node of roots) {
          const stateIcon = node.state === 'fulfilled' ? '✓' : node.state === 'rejected' ? '✗' : '⋯';
          output.push(`- ${stateIcon} ${node.name}${node.valueType ? ` (${node.valueType})` : ''}`);
        }
        output.push('');
      }

      if (nonRoots.length > 0) {
        output.push(`## Dependent nodes`);
        for (const node of nonRoots) {
          const stateIcon = node.state === 'fulfilled' ? '✓' : node.state === 'rejected' ? '✗' : '⋯';
          const deps = node.inputs.join(', ');
          output.push(`- ${stateIcon} ${node.name}${node.valueType ? ` (${node.valueType})` : ''} ← [${deps}]`);
        }
        output.push('');
      }

      // Show edges in a compact format
      if (edges.length > 0) {
        output.push(`## Edges (from → to)`);
        for (const edge of edges) {
          output.push(`  ${edge.from} → ${edge.to}`);
        }
      }

      const graphOutput = await handleLargeResponse(output.join('\n'), 'dep-graph');
      return {
        content: [{
          type: 'text',
          text: graphOutput
        }]
      };
    }

    if (name === 'BrowserEval') {
      const { notebook, code, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!code) {
        return {
          content: [{ type: 'text', text: 'Error: code is required' }],
          isError: true
        };
      }

      const response = await requestBrowserEval(code, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      if (response.error) {
        const output = [`Execution error: ${response.error}`];
        if (response.stack) {
          output.push(`Stack:\n${response.stack.split('\n').slice(0, 5).join('\n')}`);
        }
        return {
          content: [{
            type: 'text',
            text: output.join('\n')
          }]
        };
      }

      // Return image content block for Canvas/SVG results
      const result = response.result;
      if (result?.__type === 'Canvas' && result.data) {
        return {
          content: [
            { type: 'text', text: `Result:\nCanvas (${result.width}x${result.height})` },
            { type: 'image', data: result.data, mimeType: 'image/png' }
          ]
        };
      }

      if (result?.__type === 'SVG' && result.data) {
        return {
          content: [
            { type: 'text', text: `Result:\nSVG (${result.width}x${result.height})` },
            { type: 'image', data: result.data, mimeType: 'image/png' }
          ]
        };
      }

      const evalOutput = await handleLargeResponse(`Result:\n${formatValue(response.result)}`, 'browser-eval-result');
      return {
        content: [{
          type: 'text',
          text: evalOutput
        }]
      };
    }

    if (name === 'MouseClick') {
      const { notebook, selector, x = 0, y = 0, button = 0, timeout_ms = DEFAULT_TIMEOUT } = args;

      const response = await requestMouseClick({ selector, x, y, button }, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Clicked at (${response.clientX}, ${response.clientY})${selector ? ` on ${selector}` : ''}`
        }]
      };
    }

    if (name === 'MouseDrag') {
      const {
        notebook,
        selector,
        startX = 0,
        startY = 0,
        endX = 0,
        endY = 0,
        duration = 300,
        button = 0,
        timeout_ms = DEFAULT_TIMEOUT
      } = args;

      const response = await requestMouseDrag(
        { selector, startX, startY, endX, endY, duration, button },
        Math.max(timeout_ms, duration + 1000),  // Ensure timeout > duration
        notebook
      );

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Dragged from (${response.startClientX}, ${response.startClientY}) to (${response.endClientX}, ${response.endClientY}) over ${response.actualDuration}ms (${response.moveCount} move events)${selector ? ` on ${selector}` : ''}`
        }]
      };
    }

    if (name === 'MouseWheel') {
      const { notebook, selector, x = 0, y = 0, duration = 300, deltaX = 0, deltaY = 0, timeout_ms = DEFAULT_TIMEOUT } = args;

      const response = await requestMouseWheel(
        { selector, x, y, duration, deltaX, deltaY },
        Math.max(timeout_ms, duration + 1000),
        notebook
      );

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Scrolled (deltaX: ${deltaX}, deltaY: ${deltaY}) at (${response.clientX}, ${response.clientY})${selector ? ` on ${selector}` : ''}`
        }]
      };
    }

    if (name === 'MouseHover') {
      const { notebook, selector, x = 0, y = 0, timeout_ms = DEFAULT_TIMEOUT } = args;

      const response = await requestMouseHover({ selector, x, y }, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Hovered at (${response.clientX}, ${response.clientY})${selector ? ` on ${selector}` : ''}`
        }]
      };
    }

    if (name === 'SendKeys') {
      const { notebook, keys, selector, modifiers, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!keys) {
        return {
          content: [{ type: 'text', text: 'Error: keys is required' }],
          isError: true
        };
      }

      const response = await requestSendKeys(keys, selector, modifiers, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Sent ${response.keysSent} key(s) to ${response.target}${selector ? ` (${selector})` : ''}`
        }]
      };
    }

    if (name === 'RuntimeEval') {
      const { notebook, body, name: varName, timeout_ms = 10000 } = args;

      if (!body) {
        return {
          content: [{ type: 'text', text: 'Error: body is required' }],
          isError: true
        };
      }

      // Generate a random _tmp_ name if not provided; browser will auto-delete _tmp_* variables after resolution
      const actualName = varName || `_tmp_${Math.random().toString(36).slice(2, 10)}`;

      const response = await requestRuntimeEval(actualName, body, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      if (response.state === 'fulfilled') {
        const value = response.value;
        const output = [];

        // Add persistence info if named
        if (varName) {
          output.push(`Stored as: ${varName}`);
        }

        // Return image content block for Canvas/SVG values
        if (value?.__type === 'Canvas' && value.data) {
          output.push(`Canvas (${value.width}x${value.height})`);
          return {
            content: [
              { type: 'text', text: output.join('\n') },
              { type: 'image', data: value.data, mimeType: 'image/png' }
            ]
          };
        }

        if (value?.__type === 'SVG' && value.data) {
          output.push(`SVG (${value.width}x${value.height})`);
          return {
            content: [
              { type: 'text', text: output.join('\n') },
              { type: 'image', data: value.data, mimeType: 'image/png' }
            ]
          };
        }

        // Format the value
        const formatted = formatValue(response.value);
        if (varName) {
          output.push('');
          output.push(formatted);
          const result = await handleLargeResponse(output.join('\n'), `runtime-eval-${actualName}`);
          return { content: [{ type: 'text', text: result }] };
        } else {
          const result = await handleLargeResponse(formatted, 'runtime-eval-result');
          return { content: [{ type: 'text', text: result }] };
        }
      } else if (response.state === 'rejected') {
        const output = [`Error: ${response.error}`];
        if (response.stack) {
          output.push(`Stack: ${response.stack.split('\n').slice(0, 3).join('\n  ')}`);
        }
        return {
          content: [{ type: 'text', text: output.join('\n') }],
          isError: true
        };
      } else if (response.state === 'pending') {
        return {
          content: [{ type: 'text', text: 'Timeout: expression did not resolve within the specified time' }],
          isError: true
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
}

// Set up the tool executor for HTTP proxy endpoint
executeToolCall = handleToolExecution;

// Handle MCP tool calls - uses executeToolCall which may forward to owner
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return executeToolCall(name, args || {});
});

// Owner health check interval
const OWNER_HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
let ownerHealthCheckTimer = null;
let isRunningAsClient = false;
let currentOwner = null;

/**
 * Make an HTTP request to the owner
 */
async function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Forward a tool call to the owner via HTTP
 * Some tools (FocusNotebook, ListNotebooks) are handled locally
 */
async function forwardToolCallToOwner(name, args) {
  if (!currentOwner) {
    throw new Error('No owner available');
  }

  // FocusNotebook is handled locally - just store the focused notebook
  if (name === 'FocusNotebook') {
    const { notebook } = args || {};
    if (!notebook) {
      return {
        content: [{ type: 'text', text: 'Error: notebook is required' }],
        isError: true
      };
    }
    // Store locally and verify it exists by querying owner's ListNotebooks
    const listResult = await forwardToolCallToOwner('ListNotebooks', {});
    const listText = listResult.content?.[0]?.text || '';

    // Check if the notebook exists in the list
    if (!listText.includes(notebook)) {
      return {
        content: [{ type: 'text', text: `Notebook "${notebook}" not found.\n\n${listText}` }],
        isError: true
      };
    }

    focusedNotebook = notebook;
    return {
      content: [{
        type: 'text',
        text: `Focused on notebook: ${notebook}\n\nAll subsequent commands will target this notebook.`
      }]
    };
  }

  // ListNotebooks - forward to owner but add local focus info
  if (name === 'ListNotebooks') {
    const url = `http://localhost:${currentOwner.http}/mcp/call`;
    const response = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, args: args || {} })
    });

    if (response.status !== 200) {
      throw new Error(response.data?.error || 'Owner request failed');
    }

    // Modify the response to show local focus state
    const result = response.data;
    if (result.content?.[0]?.text) {
      let text = result.content[0].text;
      // Replace the owner's focus info with our local focus
      text = text.replace(/\nFocused:.*/, '');
      text = text.replace(/\nNo notebook focused.*/, '');
      const focusInfo = focusedNotebook
        ? `\nFocused: ${focusedNotebook}`
        : '\nNo notebook focused (use FocusNotebook if needed)';
      // Insert after instance line
      text = text.replace(/(Instance: [^\n]+)/, `$1${focusInfo}`);
      result.content[0].text = text;
    }
    return result;
  }

  // For other tools, inject the notebook parameter if we have a local focus
  const forwardArgs = { ...args };
  if (focusedNotebook && !forwardArgs.notebook) {
    forwardArgs.notebook = focusedNotebook;
  }

  const url = `http://localhost:${currentOwner.http}/mcp/call`;
  const response = await httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: name, args: forwardArgs })
  });

  if (response.status !== 200) {
    throw new Error(response.data?.error || 'Owner request failed');
  }

  return response.data;
}

/**
 * Check if the owner is still alive
 */
async function checkOwnerHealth() {
  if (!currentOwner) return false;

  try {
    const url = `http://localhost:${currentOwner.http}/ping`;
    const response = await httpRequest(url);
    return response.status === 200 && response.data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Promote this client instance to owner
 */
async function promoteToOwner() {
  console.error('[Server] Owner died, promoting to owner...');

  // Stop health check
  if (ownerHealthCheckTimer) {
    clearInterval(ownerHealthCheckTimer);
    ownerHealthCheckTimer = null;
  }

  isRunningAsClient = false;
  currentOwner = null;

  // Start our own servers
  console.error('[Server] Finding available ports...');
  const ports = await findAvailablePorts();
  HTTP_PORT = ports.httpPort;
  WS_PORT = ports.wsPort;
  console.error(`[Server] Using ports: HTTP=${HTTP_PORT}, WS=${WS_PORT}`);

  createHttpServer();
  createWebSocketServer();

  // Update registry - register ourselves and become owner
  await registerInstance();
  await becomeOwner();

  // Switch tool executor back to local execution
  executeToolCall = handleToolExecution;

  console.error('[Server] Promoted to owner successfully');
}

/**
 * Start owner health monitoring
 */
function startOwnerHealthCheck() {
  ownerHealthCheckTimer = setInterval(async () => {
    const healthy = await checkOwnerHealth();
    if (!healthy) {
      console.error('[Server] Owner health check failed');
      await promoteToOwner();
    }
  }, OWNER_HEALTH_CHECK_INTERVAL);
}

/**
 * Run as owner - start HTTP/WebSocket servers
 */
async function runAsOwner() {
  console.error('[Server] Running as owner');

  // Find available ports
  console.error('[Server] Finding available ports...');
  const ports = await findAvailablePorts();
  HTTP_PORT = ports.httpPort;
  WS_PORT = ports.wsPort;
  console.error(`[Server] Using ports: HTTP=${HTTP_PORT}, WS=${WS_PORT}`);

  // Create servers
  createHttpServer();
  createWebSocketServer();

  // Register this instance and become owner
  await registerInstance();
  await becomeOwner();

  // Tool executor uses local execution
  executeToolCall = handleToolExecution;
}

/**
 * Run as client - proxy to owner
 */
async function runAsClient(owner) {
  console.error(`[Server] Running as client, owner: ${owner.id} (http: ${owner.http})`);

  isRunningAsClient = true;
  currentOwner = owner;

  // Register ourselves as a client instance (no ports)
  const registry = await readRegistry();
  registry.instances[INSTANCE_ID] = {
    pid: process.pid,
    isClient: true,
    ownerHttp: owner.http,
    startedAt: Date.now()
  };
  await writeRegistry(registry);
  console.error(`[Server] Registered as client instance ${INSTANCE_ID}`);

  // Override tool executor to forward to owner
  executeToolCall = forwardToolCallToOwner;

  // Start health monitoring
  startOwnerHealthCheck();
}

// Start servers
async function main() {
  // Clean up old response files from previous sessions
  await cleanupOldResponses();

  // Read and prune the registry first (cleans up dead instances)
  await readRegistry();

  // Check if there's already a live owner
  const existingOwner = await findLiveOwner();

  if (existingOwner) {
    // Run as client - proxy to existing owner
    await runAsClient(existingOwner);
  } else {
    // Run as owner - start servers
    await runAsOwner();
  }

  // Set up cleanup on exit
  const cleanup = async () => {
    // Stop health check timer if running as client
    if (ownerHealthCheckTimer) {
      clearInterval(ownerHealthCheckTimer);
      ownerHealthCheckTimer = null;
    }
    await unregisterInstance();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    // Synchronous cleanup attempt on exit - try to remove ourselves from registry
    try {
      if (existsSync(REGISTRY_FILE)) {
        const fs = require('fs');
        const content = fs.readFileSync(REGISTRY_FILE, 'utf-8');
        // Handle empty file gracefully
        if (!content.trim()) {
          return;
        }
        const registry = JSON.parse(content);
        if (registry.instances) {
          delete registry.instances[INSTANCE_ID];
          fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
        }
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Server] Debug Notebook MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
