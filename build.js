#!/usr/bin/env node

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/vite/client/index.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/debug-client.js",
  target: ["es2020"],
  minify: false, // Keep readable for debugging
  sourcemap: true,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
  console.log("Built dist/debug-client.js");
}
