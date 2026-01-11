/**
 * Exposes the Observable runtime on window for the debug client.
 * This file is served by Vite during development only.
 */
import { main } from '@observablehq/notebook-kit/runtime';
window.__observableRuntime = main;
