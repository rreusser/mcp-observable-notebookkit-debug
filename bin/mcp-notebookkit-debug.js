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

// Debug directory for this project
const DEBUG_DIR = join(process.cwd(), '.notebookkit-debug');
const PORT_FILE = join(DEBUG_DIR, 'port');

/**
 * Ensure the debug directory exists
 */
async function ensureDebugDir() {
  if (!existsSync(DEBUG_DIR)) {
    await mkdir(DEBUG_DIR, { recursive: true });
  }
}

/**
 * Write the current ports to the port file
 */
async function writePortFile() {
  await ensureDebugDir();
  await writeFile(PORT_FILE, JSON.stringify({ http: HTTP_PORT, ws: WS_PORT }, null, 2));
  console.error(`[Server] Port file written to ${PORT_FILE}`);
}

/**
 * Clean up port file on exit
 */
async function cleanupPortFile() {
  try {
    if (existsSync(PORT_FILE)) {
      await rm(PORT_FILE);
      console.error('[Server] Port file cleaned up');
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

/**
 * Try to start HTTP server on a port, returns true if successful
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
    testServer.listen(port);
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
    // No notebook specified - return the only client or error
    if (clients.size === 0) {
      return { error: 'No connected notebooks' };
    }
    if (clients.size === 1) {
      const [client, info] = clients.entries().next().value;
      return { client, info };
    }
    // Multiple clients - list them
    const list = Array.from(clients.values())
      .map((info, i) => `  ${i}: ${getNotebookId(info.url)} (${info.url})`)
      .join('\n');
    return { error: `Multiple notebooks connected. Specify which one:\n${list}` };
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
        currentSession: currentSessionId,
        sessions: Array.from(sessions.keys()),
        notebooks,
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
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Debug Server Running\n');
    }
  });

  httpServer.listen(HTTP_PORT, () => {
    console.error(`[Server] HTTP server running on http://localhost:${HTTP_PORT}`);
  });
}

/**
 * Create and start WebSocket server for browser connections
 */
function createWebSocketServer() {
  wss = new WebSocketServer({ port: WS_PORT });

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

  console.error(`[Server] WebSocket server running on ws://localhost:${WS_PORT}`);
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
      type === 'eval_response' || type === 'mouse_response' ||
      type === 'keyboard_response' || type === 'define_response' ||
      type === 'delete_response' || type === 'injected_list_response') {
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
      clientInfo.url = data.url;
      clientInfo.sessionId = sessionId;
      console.error(`[Server] Notebook connected: ${getNotebookId(data.url)} (${data.url})`);
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
  return createRequest('GetValueMetadata', { name }, timeout, notebook);
}

/**
 * Request errors from browser
 */
async function requestErrors(timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetErrors', {}, timeout, notebook);
}

/**
 * Request to set an input value in browser
 */
async function requestSetInput(name, value, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('SetInput', { name, value }, timeout, notebook);
}

/**
 * Request element content from browser
 */
async function requestElementContent(selector, mode = 'auto', timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetElementContent', { selector, mode }, timeout, notebook);
}

/**
 * Request dependency graph from browser
 */
async function requestDependencyGraph(filters = {}, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('GetDependencyGraph', { filters }, timeout, notebook);
}

/**
 * Request JavaScript code execution in browser
 */
async function requestEval(code, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('Eval', { code }, timeout, notebook);
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
 * Request keyboard input in browser
 */
async function requestSendKeys(keys, selector, modifiers, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('SendKeys', { keys, selector, modifiers }, timeout, notebook);
}

/**
 * Request to define an ephemeral variable in the runtime
 */
async function requestDefineVariable(name, inputs, expression, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('DefineVariable', { name, inputs, expression }, timeout, notebook);
}

/**
 * Request to delete an injected variable
 */
async function requestDeleteVariable(name, timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('DeleteVariable', { name }, timeout, notebook);
}

/**
 * Request list of injected variables
 */
async function requestListInjectedVariables(timeout = DEFAULT_TIMEOUT, notebook = null) {
  return createRequest('ListInjectedVariables', {}, timeout, notebook);
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
      output.push(`[${time}] ERROR: ${error.message}`);

      if (error.cellId) {
        output.push(`  Cell: ${error.cellId}`);
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
  description: 'Target notebook (URL, path like "index" or "second-notebook", or index like "0"). Required when multiple notebooks are connected.'
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
        name: 'GetLogs',
        description: 'Get logs from the current or most recent session without triggering a refresh',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Specific session ID (optional, uses current session if not provided)'
            },
            filter: {
              type: 'string',
              description: 'Filter logs by substring match'
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
        description: 'Get all errors from the notebook. Includes both DOM-reported errors and values in rejected state.',
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
            mode: {
              type: 'string',
              enum: ['auto', 'text', 'html', 'image'],
              description: 'Content extraction mode. "auto" (default) detects based on element type. "text" returns textContent, "html" returns innerHTML, "image" captures as PNG.',
              default: 'auto'
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
        name: 'Eval',
        description: 'Execute JavaScript in the browser context. Runs outside the Observable runtime—use as a last resort when runtime-aware tools (GetValue, SetInput, DefineVariable) don\'t suffice. Useful for DOM inspection, computed styles, or browser APIs not exposed through the runtime.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
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
        name: 'DefineVariable',
        description: 'Inject an ephemeral value into the Observable runtime. The value participates in the reactive graph and can depend on existing values. Prefer this over Eval when computing derived values from runtime state. Example: define "c" with expression "a + b" to compute the sum of values a and b.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            name: {
              type: 'string',
              description: 'Name for the new variable'
            },
            expression: {
              type: 'string',
              description: 'JavaScript expression to compute the value. Can reference other notebook variables.'
            },
            inputs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicit list of dependencies (variable names). If omitted, dependencies are auto-detected from the expression.'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait for the value to resolve',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['name', 'expression']
        }
      },
      {
        name: 'DeleteVariable',
        description: 'Delete an ephemeral value that was previously injected into the Observable runtime with DefineVariable.',
        inputSchema: {
          type: 'object',
          properties: {
            notebook: notebookParam,
            name: {
              type: 'string',
              description: 'Name of the injected variable to delete'
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
        name: 'ListInjectedVariables',
        description: 'List all ephemeral values that have been injected into the Observable runtime with DefineVariable.',
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
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'ListNotebooks') {
      if (clients.size === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No notebooks connected.\n\nMake sure your notebook is running with the debug plugin enabled.'
          }]
        };
      }

      const notebooks = Array.from(clients.values()).map((info, i) => {
        const id = getNotebookId(info.url);
        const connectedAgo = Math.round((Date.now() - info.connectedAt) / 1000);
        return `${i}: ${id}\n   URL: ${info.url}\n   Connected: ${connectedAgo}s ago`;
      });

      return {
        content: [{
          type: 'text',
          text: `Connected notebooks (${clients.size}):\n\n${notebooks.join('\n\n')}`
        }]
      };
    }

    if (name === 'Refresh') {
      const { notebook, wait_for_completion, timeout_ms } = args || {};
      const waitForSignal = wait_for_completion !== false;
      const timeout = timeout_ms || (waitForSignal ? COMPLETION_TIMEOUT : 5000);

      const sessionId = sendRefresh(notebook);
      const result = await waitForCompletion(sessionId, timeout);

      const session = result.session;
      const errorCount = session?.errors?.length || 0;
      const logCount = session?.logs?.length || 0;

      const statusText = result.completed
        ? `Notebook refreshed in ${result.duration}ms`
        : `Timeout after ${result.duration}ms`;

      const output = [statusText];

      if (errorCount > 0) {
        output.push(`Errors: ${errorCount}`);
        session.errors.forEach(error => {
          output.push(`  - ${error.message}${error.cellId ? ` (cell: ${error.cellId})` : ''}`);
        });
      } else {
        output.push('No errors');
      }

      output.push(`Logs: ${logCount} (use GetLogs to view)`);

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

      return {
        content: [{
          type: 'text',
          text: formatValueResponse(response)
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

      return {
        content: [{
          type: 'text',
          text: output.join('\n')
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

    if (name === 'GetLogs') {
      const { session_id, filter, max_chars = 2000 } = args || {};

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
          text: formatSessionOutput(session, filter, max_chars)
        }]
      };
    }

    if (name === 'GetErrors') {
      const { notebook, timeout_ms = DEFAULT_TIMEOUT } = args || {};

      const response = await requestErrors(timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      if (response.errors.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No errors found in notebook.'
          }]
        };
      }

      const errorList = response.errors.map(e => {
        const name = e.name || e.cell;
        let msg = `Value: ${name}\nError: ${e.error}`;
        if (e.stack) {
          const stackLines = e.stack.split('\n').slice(0, 4).join('\n');
          msg += `\nStack:\n${stackLines}`;
        }
        return msg;
      }).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${response.errors.length} error(s):\n\n${errorList}`
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
      const { notebook, selector, mode = 'auto', timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!selector) {
        return {
          content: [{ type: 'text', text: 'Error: selector is required' }],
          isError: true
        };
      }

      const response = await requestElementContent(selector, mode, timeout_ms, notebook);

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
        // Handle text content
        if (response.textContent !== undefined) {
          textOutput.push(`\nText content:\n${response.textContent}`);
        }

        // Handle HTML content
        if (response.innerHTML !== undefined && mode === 'html') {
          textOutput.push(`\nHTML:\n${response.innerHTML}`);
        }

        // Handle SVG source
        if (response.svgSource !== undefined) {
          textOutput.push(`\nSVG source:\n${response.svgSource}`);
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
        for (const edge of edges.slice(0, 50)) {
          output.push(`  ${edge.from} → ${edge.to}`);
        }
        if (edges.length > 50) {
          output.push(`  ... and ${edges.length - 50} more`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: output.join('\n')
        }]
      };
    }

    if (name === 'Eval') {
      const { notebook, code, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!code) {
        return {
          content: [{ type: 'text', text: 'Error: code is required' }],
          isError: true
        };
      }

      const response = await requestEval(code, timeout_ms, notebook);

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

      return {
        content: [{
          type: 'text',
          text: `Result:\n${formatValue(response.result)}`
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

    if (name === 'DefineVariable') {
      const { notebook, name: varName, expression, inputs, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!varName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      if (!expression) {
        return {
          content: [{ type: 'text', text: 'Error: expression is required' }],
          isError: true
        };
      }

      const response = await requestDefineVariable(varName, inputs, expression, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      const output = [`Defined: ${varName}`];
      output.push(`Expression: ${expression}`);

      if (response.inputs && response.inputs.length > 0) {
        output.push(`Dependencies: ${response.inputs.join(', ')}`);
      } else {
        output.push(`Dependencies: (none)`);
      }

      output.push(`State: ${response.state}`);

      if (response.state === 'fulfilled') {
        // Return image content block for Canvas/SVG values
        const value = response.value;
        if (value?.__type === 'Canvas' && value.data) {
          output.push('');
          output.push(`Value:\nCanvas (${value.width}x${value.height})`);
          return {
            content: [
              { type: 'text', text: output.join('\n') },
              { type: 'image', data: value.data, mimeType: 'image/png' }
            ]
          };
        }

        if (value?.__type === 'SVG' && value.data) {
          output.push('');
          output.push(`Value:\nSVG (${value.width}x${value.height})`);
          return {
            content: [
              { type: 'text', text: output.join('\n') },
              { type: 'image', data: value.data, mimeType: 'image/png' }
            ]
          };
        }

        output.push('');
        output.push('Value:');
        output.push(formatValue(response.value));
      } else if (response.state === 'rejected') {
        output.push(`Error: ${response.error}`);
        if (response.stack) {
          output.push(`Stack: ${response.stack.split('\n').slice(0, 3).join('\n  ')}`);
        }
      } else if (response.state === 'pending') {
        output.push('(Value is still computing)');
      }

      return {
        content: [{
          type: 'text',
          text: output.join('\n')
        }]
      };
    }

    if (name === 'DeleteVariable') {
      const { notebook, name: varName, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!varName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      const response = await requestDeleteVariable(varName, timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Deleted injected variable: ${varName}`
        }]
      };
    }

    if (name === 'ListInjectedVariables') {
      const { notebook, timeout_ms = DEFAULT_TIMEOUT } = args || {};

      const response = await requestListInjectedVariables(timeout_ms, notebook);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      if (response.variables.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No injected variables. Use DefineVariable to inject ephemeral variables into the runtime.'
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Injected variables (${response.variables.length}):\n\n- ${response.variables.join('\n- ')}`
        }]
      };
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
});

// Start servers
async function main() {
  // Find available ports
  console.error('[Server] Finding available ports...');
  const ports = await findAvailablePorts();
  HTTP_PORT = ports.httpPort;
  WS_PORT = ports.wsPort;
  console.error(`[Server] Using ports: HTTP=${HTTP_PORT}, WS=${WS_PORT}`);

  // Create servers
  createHttpServer();
  createWebSocketServer();

  // Write port file for Vite plugin to read
  await writePortFile();

  // Set up cleanup on exit
  const cleanup = async () => {
    await cleanupPortFile();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    // Synchronous cleanup attempt on exit
    try {
      if (existsSync(PORT_FILE)) {
        require('fs').unlinkSync(PORT_FILE);
      }
    } catch (err) {
      // Ignore
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
