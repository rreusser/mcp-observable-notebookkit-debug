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
import { tmpdir } from 'os';
import { writeFile } from 'fs/promises';
import { join } from 'path';

const HTTP_PORT = 9898;
const WS_PORT = 9899;
const DEFAULT_TIMEOUT = 5000;
const COMPLETION_TIMEOUT = 30000;

// Session storage
const sessions = new Map();
let currentSessionId = null;

// Connected browser clients
const clients = new Set();

// Pending requests (for bidirectional communication)
const pendingRequests = new Map();
let requestCounter = 0;

/**
 * Create HTTP server for status/session endpoints
 */
const httpServer = http.createServer((req, res) => {
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
    res.end(JSON.stringify({
      currentSession: currentSessionId,
      sessions: Array.from(sessions.keys()),
      connectedClients: clients.size
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

/**
 * Create WebSocket server for browser connections
 */
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
  console.error('[Server] Client connected');
  clients.add(ws);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleBrowserMessage(message, ws);
    } catch (err) {
      console.error('[Server] Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    console.error('[Server] Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[Server] WebSocket error:', err);
  });
});

/**
 * Handle messages from browser clients
 */
function handleBrowserMessage(message, ws) {
  const { type, sessionId, data, timestamp, requestId } = message;

  // Handle responses to our requests (new value-centric responses)
  if (type === 'value_response' || type === 'values_response' ||
      type === 'values_list_response' || type === 'metadata_response' ||
      type === 'cell_value_response' || type === 'cells_list_response' ||
      type === 'errors_response') {
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
    clients.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(broadcastMsg);
      }
    });
    return;
  }

  // Handle session start
  if (type === 'session_start') {
    currentSessionId = sessionId;
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
 */
function createRequest(type, data, timeout = DEFAULT_TIMEOUT) {
  const requestId = `req-${++requestCounter}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout'));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timer });

    const message = JSON.stringify({ type, requestId, ...data });
    let sent = false;
    clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
        sent = true;
      }
    });

    if (!sent) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error('No connected clients'));
    }
  });
}

/**
 * Request a single value from browser
 */
async function requestValue(name, timeout = DEFAULT_TIMEOUT) {
  return createRequest('GetValue', { name }, timeout);
}

/**
 * Request multiple/all values from browser
 */
async function requestValues(names, timeout = DEFAULT_TIMEOUT) {
  return createRequest('GetValues', { names }, timeout);
}

/**
 * Request list of values from browser
 */
async function requestValuesList(timeout = DEFAULT_TIMEOUT) {
  return createRequest('ListValues', {}, timeout);
}

/**
 * Request value metadata from browser
 */
async function requestValueMetadata(name, timeout = DEFAULT_TIMEOUT) {
  return createRequest('GetValueMetadata', { name }, timeout);
}

/**
 * Request errors from browser
 */
async function requestErrors(timeout = DEFAULT_TIMEOUT) {
  return createRequest('GetErrors', {}, timeout);
}

/**
 * Broadcast refresh command to all clients
 */
function broadcastRefresh() {
  const sessionId = `session-${Date.now()}`;
  const message = JSON.stringify({ type: 'Refresh', sessionId });

  console.error(`[Server] Broadcasting refresh (new session: ${sessionId})`);

  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });

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
 */
function formatSessionOutput(session, filter) {
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

  return output.join('\n');
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'Refresh',
        description: 'Trigger notebook page refresh and wait for completion. Captures all logs and errors from the new session.',
        inputSchema: {
          type: 'object',
          properties: {
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
        description: 'Get list of all named values in the running notebook',
        inputSchema: {
          type: 'object',
          properties: {
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
        description: 'Get a specific value from the running notebook. Returns the value along with its state (fulfilled, pending, or rejected).',
        inputSchema: {
          type: 'object',
          properties: {
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
        description: 'Get multiple values from the notebook at once. If no names provided, returns all values. Useful for getting a snapshot of the entire notebook state.',
        inputSchema: {
          type: 'object',
          properties: {
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
        description: 'Get metadata about a value including its state, type, dependencies (inputs), and dependents (outputs) without fetching the full value.',
        inputSchema: {
          type: 'object',
          properties: {
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
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          }
        }
      },
      {
        name: 'CaptureImage',
        description: 'Capture a canvas value and save it to a temp file. Returns the file path so it can be viewed.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the value containing a canvas'
            },
            timeout_ms: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT
            }
          },
          required: ['name']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'Refresh') {
      const waitForSignal = args?.wait_for_completion !== false;
      const timeout = args?.timeout_ms || (waitForSignal ? COMPLETION_TIMEOUT : 5000);

      const sessionId = broadcastRefresh();
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
      const { timeout_ms = DEFAULT_TIMEOUT } = args || {};

      const response = await requestValuesList(timeout_ms);

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
      const { name: valueName, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!valueName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      const response = await requestValue(valueName, timeout_ms);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
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
      const { names, timeout_ms = 100 } = args || {};

      const response = await requestValues(names, timeout_ms);

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
      const { name: valueName, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!valueName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      const response = await requestValueMetadata(valueName, timeout_ms);

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
      const { session_id, filter } = args || {};

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
          text: formatSessionOutput(session, filter)
        }]
      };
    }

    if (name === 'GetErrors') {
      const { timeout_ms = DEFAULT_TIMEOUT } = args || {};

      const response = await requestErrors(timeout_ms);

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

    if (name === 'CaptureImage') {
      const { name: valueName, timeout_ms = DEFAULT_TIMEOUT } = args;

      if (!valueName) {
        return {
          content: [{ type: 'text', text: 'Error: name is required' }],
          isError: true
        };
      }

      const response = await requestValue(valueName, timeout_ms);

      if (!response.success) {
        return {
          content: [{ type: 'text', text: `Error: ${response.error}` }],
          isError: true
        };
      }

      if (response.state === 'rejected') {
        return {
          content: [{ type: 'text', text: `Error: Value is in rejected state: ${response.error}` }],
          isError: true
        };
      }

      if (response.state === 'pending') {
        return {
          content: [{ type: 'text', text: `Error: Value is still pending` }],
          isError: true
        };
      }

      const value = response.value;

      // Check if it's a canvas with base64 data
      if (value?.__type === 'Canvas' && value.data) {
        const filename = `notebook-capture-${valueName}-${Date.now()}.png`;
        const filepath = join(tmpdir(), filename);

        const buffer = Buffer.from(value.data, 'base64');
        await writeFile(filepath, buffer);

        return {
          content: [{
            type: 'text',
            text: `Captured canvas "${valueName}" (${value.width}x${value.height}) to:\n${filepath}\n\nUse the Read tool to view the image.`
          }]
        };
      }

      // Check if it's an element that might be an image
      if (value?.__type === 'Element' && value.tagName === 'img') {
        return {
          content: [{
            type: 'text',
            text: `Value "${valueName}" is an <img> element. Image capture for <img> tags is not yet supported.`
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Value "${valueName}" is not a canvas. Type: ${value?.__type || typeof value}`
        }],
        isError: true
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
  httpServer.listen(HTTP_PORT, () => {
    console.error(`[Server] HTTP server running on http://localhost:${HTTP_PORT}`);
  });

  console.error(`[Server] WebSocket server running on ws://localhost:${WS_PORT}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Debug Notebook MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
