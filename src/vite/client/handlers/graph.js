/**
 * Dependency graph handler
 */

import { getRuntimeModule, getValueState, getValueTypeHint } from "../utils/runtime.js";

/**
 * Handle GetDependencyGraph request - returns the dependency graph with optional filtering
 */
export async function handleGetDependencyGraphRequest(client, message) {
  const runtime = getRuntimeModule();
  const filters = message.filters || {};

  if (!runtime || !runtime._scope) {
    client.send({
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
      const stateResult = await getValueState(runtime, name, 50);

      // Get type hint if fulfilled
      let valueType = null;
      if (stateResult.state === 'fulfilled' && stateResult.value !== undefined) {
        valueType = getValueTypeHint(stateResult.value);
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
        client.send({
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

    client.send({
      type: "dependencygraph_response",
      requestId: message.requestId,
      success: true,
      graph: { nodes, edges },
    });
  } catch (error) {
    client.send({
      type: "dependencygraph_response",
      requestId: message.requestId,
      success: false,
      error: error.message,
    });
  }
}
