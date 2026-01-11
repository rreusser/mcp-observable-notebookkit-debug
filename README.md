# mcp-observable-notebookkit-debug

MCP server for debugging [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) notebooks. Enables AI assistants to inspect cell values, view errors, and capture canvas output from notebooks running in a web browser.

## Setup

### 1. Install the package (not yet published to npm)

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

### 3. Configure the MCP server

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

### 4. Run the dev server

```bash
npm run start   # or: vite
```

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
