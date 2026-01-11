import { defineConfig } from "vite";
import { observable, config } from "@observablehq/notebook-kit/vite";
import { debugNotebook } from "..";

export default defineConfig({
  ...config(),
  plugins: [debugNotebook(), observable()],
});
