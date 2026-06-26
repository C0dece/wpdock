// esbuild script for WPDock VS Code extension
const esbuild = require("esbuild");

const isDev = process.argv.includes("--dev");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",
  ],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: isDev,
  minify: !isDev,
  logLevel: "info",
  // Some deps dynamically require .map files; treat them as empty to avoid bundle errors.
  loader: { ".map": "empty" },
  // Suppress dynamic require warnings from third-party deps.
  ignoreAnnotations: true,
};

if (isDev) {
  esbuild.context(options).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes...");
  });
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
