# Example

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm start
```

Open http://localhost:5173 in your browser.

## Using Claude Code

With the dev server running, start Claude Code from this directory. You can ask Claude to inspect notebook cells. For example, given a notebook like this:

```html
<!doctype html>
<notebook>
  <title>Hello, world!</title>
  <script type="text/markdown">
    # Hello, world!
  </script>
  <script type="module" pinned>
    const x = 1 + 2;
  </script>
</notebook>
```

You can ask Claude to inspect outputs:

```
❯ What is the value of x?

⏺ Notebook - GetCellValue (MCP)(cell_name: "x")
⎿  Cell: x

     3

⏺ The value of x is 3.
```
