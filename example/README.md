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

With the dev server running, start Claude Code from this directory. You can ask Claude to inspect notebook values.

### Example: Getting a value

```
> What is the value of number?

Notebook - GetValue (MCP)(name: "number")
  Value: number
  State: fulfilled

  42

The value of number is 42.
```

### Example: Listing all values

```
> List all the values in the notebook

Notebook - ListValues (MCP)()
  Available values (24):
  - array
  - asyncFn
  - asyncValue
  - boolean
  ...

The notebook contains 24 values including...
```

### Example: Checking for errors

```
> Are there any errors?

Notebook - GetErrors (MCP)()
  Found 2 error(s):

  Value: runtimeError
  Error: This is a runtime error

  ---

  Value: referenceError
  Error: undefinedVariable is not defined

Yes, there are 2 errors...
```

### Example: Getting metadata

```
> What does computed depend on?

Notebook - GetValueMetadata (MCP)(name: "computed")
  Name: computed
  State: fulfilled
  Type: number
  Dependencies: number

The computed value depends on number...
```

### Example: Capturing a canvas

```
> Show me the canvas

Notebook - CaptureImage (MCP)(name: "canvas")
  Captured canvas "canvas" (200x100) to:
  /var/folders/.../notebook-capture-canvas-1234567890.png

[Shows captured image]
```

## Test Cases

The example notebook includes various test cases:
- Primitive values: number, string, boolean, null
- Complex types: array, object, Map, Set, Date, RegExp
- Functions: regular and async functions
- DOM elements: canvas, div
- TypedArrays: Float32Array
- Async values: Promise (fulfilled and slow/pending)
- Errors: runtime errors and reference errors
- Circular references
- Large arrays (for truncation testing)
