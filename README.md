# mcp-observable-notebookkit-debug

> MCP server for debugging [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) notebooks.

Enables AI assistants to inspect cell values, view errors, and capture canvas output from notebooks running in a web browser. For a fully working example, see [./example](./example). This isn't yet published to NPM, so you'll need to install from GitHub, as I'm still trying kicking the tires and seeing how I feel about it.

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

You can now use an agent like Claude Code to poke and prod at notebooks running in a web browser, inspecting cell outputs and even image outputs.

## MCP Tools

| Tool               | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `RefreshNotebook`  | Refresh the page and wait for notebook initialization   |
| `ListCells`        | List all defined cells in the notebook                  |
| `GetCellValue`     | Get the current value of a specific cell                |
| `GetErrors`        | Get all runtime errors from notebook cells              |
| `GetSessionLogs`   | View console logs from the current session              |
| `CaptureCellImage` | Save a canvas cell to a temp file for visual inspection |

## License

&copy; 2026 Ricky Reusser. MIT License.
