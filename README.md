# mcp-observable-notebookkit-debug

> MCP server for debugging [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) notebooks.

Enables AI assistants to inspect values, view errors, and capture canvas output from notebooks running in a web browser. For a fully working example, see [./example](./example). This isn't yet published to NPM, so you'll need to install from GitHub, as I'm still trying kicking the tires and seeing how I feel about it.

## Why?

The [Observable Desktop](https://observablehq.com/notebook-kit/desktop) is really cool, but it had some limitations. For one, okay, so I paid Anthropic some money for Claude Code, but it's not the *right* Anthropic integration to be able to configure an API key in the app, so I'm out of luck. And I was trying to get some WebGPU experiments running, but the app didn't have access to a WebGPU context. So one thing led to another, and I wrote a quick MCP server to exfiltrate values from notebooks running in the browser.

## Setup

### 1. Install the package

```bash
npm install @rreusser/mcp-observable-notebookkit-debug
```

### 2. Add the Vite plugin

In your `vite.config.js`:

```js
import { defineConfig } from "vite";
import { observable, config } from "@observablehq/notebook-kit/vite";
import { debugNotebook } from "@rreusser/mcp-observable-notebookkit-debug";

export default defineConfig({
  ...config(),
  plugins: [debugNotebook(), observable()],
});
```

### 3. Run the dev server

```bash
vite -c vite.config.js
```

### 4. Configure the MCP server

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "Notebook": {
      "command": "mcp-notebookkit-debug",
      "args": []
    }
  }
}
```

### 5. Go!

You can now use an agent like Claude Code to poke and prod at notebooks running in a web browser, inspecting values and even capturing canvas output as images.

## MCP Tools

| Tool                      | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `ListNotebooks`           | List all connected notebooks (use when multiple notebooks are open)         |
| `Refresh`                 | Refresh the page and wait for notebook initialization                       |
| `ListValues`              | List all named values in the notebook                                       |
| `GetValue`                | Get a specific value with its state; returns images for Canvas/SVG elements |
| `GetValues`               | Get multiple/all values at once (snapshot of notebook state)                |
| `GetValueMetadata`        | Get metadata: state, type, dependencies, and dependents without full value  |
| `GetErrors`               | Get all errors (DOM-reported and values in rejected state)                  |
| `GetLogs`                 | View console logs from the current session                                  |
| `SetInput`                | Set an input value (viewof cell) to trigger reactive updates                |
| `GetElementContent`       | Get content from a DOM element by CSS selector; captures canvas/SVG as images |
| `GetDependencyGraph`      | Get the dependency graph showing how values depend on each other            |
| `Eval`                    | Execute arbitrary JavaScript in the browser context                         |
| `DefineVariable`          | Inject an ephemeral variable into the Observable runtime                    |
| `DeleteVariable`          | Delete an injected ephemeral variable                                       |
| `ListInjectedVariables`   | List all ephemeral variables injected into the runtime                      |
| `MouseClick`              | Simulate a mouse click at a position or on an element                       |
| `MouseDrag`               | Simulate a mouse drag from start to end position                            |
| `MouseWheel`              | Simulate a mouse wheel scroll at a position                                 |

### Multi-Notebook Support

When multiple notebooks are open in different browser tabs, you can target a specific notebook using the `notebook` parameter on any tool:

```
# By path (without .html extension)
notebook: "index"
notebook: "second-notebook"

# By index
notebook: "0"
notebook: "1"

# By URL
notebook: "http://localhost:5173/"
```

If multiple notebooks are connected and you don't specify which one, the tool will return an error listing the available notebooks.

Use `ListNotebooks` to see all connected notebooks with their URLs and indices.

### Value States

Values in an Observable notebook can be in one of three states:

- **fulfilled**: The value has been computed successfully
- **pending**: The value is still being computed (e.g., async/Promise)
- **rejected**: The computation threw an error

The `GetValue` and `GetValues` tools return state information along with the value or error.

### Image Support

`GetValue` automatically returns images inline for:
- **Canvas elements**: Captured as PNG
- **SVG elements**: Rendered to canvas and captured as PNG

No need to save to files - images are returned directly in the MCP response.

### Ephemeral Variables

Use `DefineVariable` to inject temporary variables into the Observable runtime for debugging and exploration. These variables participate in the reactive graph and can depend on existing notebook values.

```javascript
// Define a variable that computes from existing values
DefineVariable({
  name: "myVar",
  expression: "number * 2 + chainBase"
})

// Use an IIFE for multi-statement expressions
DefineVariable({
  name: "complex",
  expression: `(() => {
    const doubled = number * 2;
    const added = doubled + chainBase;
    return { doubled, added };
  })()`
})
```

Dependencies are auto-detected from the expression. Use `ListInjectedVariables` to see all injected variables and `DeleteVariable` to remove them.

Note: You cannot define a variable with the same name as an existing notebook cell.

### Mouse Interaction

Simulate mouse events for testing interactive visualizations:

- **`MouseClick`**: Click at coordinates or on an element (supports left/middle/right buttons)
- **`MouseDrag`**: Drag from start to end position with configurable duration
- **`MouseWheel`**: Scroll at a position with deltaX/deltaY

All mouse tools accept an optional `selector` parameter to target a specific element, with coordinates relative to that element.

## License

&copy; 2026 Ricky Reusser. MIT License.
