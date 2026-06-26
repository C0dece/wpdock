// esbuild script for WPDock VS Code extension
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const isDev = process.argv.includes("--dev");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",
    // native modules that can't be bundled
    "ssh2",
    "cpu-features",
    // browser-sync peer deps with dynamic requires
    "emitter",
    "bs-recipes",
  ],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: isDev,
  minify: !isDev,
  logLevel: "info",
  // Handle .map files required dynamically by browser-sync
  loader: { ".map": "empty" },
  // Suppress dynamic require warnings
  ignoreAnnotations: true,
};

function copyDirRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function syncBrowserSyncTemplates() {
  const targetDir = path.join(__dirname, "..", "templates");
  const outDir = path.join(__dirname, "..", "out");
  const sources = [
    {
      label: "browser-sync",
      dir: path.join(
        __dirname,
        "..",
        "node_modules",
        "browser-sync",
        "templates",
      ),
    },
    {
      label: "browser-sync-ui",
      dir: path.join(
        __dirname,
        "..",
        "node_modules",
        "browser-sync-ui",
        "templates",
      ),
    },
  ];

  let copiedAny = false;
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) {
      console.warn(`${source.label} templates not found, skipping`);
      continue;
    }
    copyDirRecursive(source.dir, targetDir);
    copiedAny = true;
  }

  if (copiedAny) {
    console.log("Synced browser-sync templates → templates/");

    // Bundled extension code executes from out/, and browser-sync resolves some
    // templates relative to that location. Keep a compatibility copy in out/.
    fs.mkdirSync(outDir, { recursive: true });
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      const sourcePath = path.join(targetDir, entry.name);
      const targetPath = path.join(outDir, entry.name);
      if (entry.isDirectory()) {
        copyDirRecursive(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
    console.log("Synced browser-sync templates → out/");
  }
}

if (isDev) {
  esbuild.context(options).then((ctx) => {
    ctx.watch();
    syncBrowserSyncTemplates();
    console.log("Watching for changes...");
  });
} else {
  esbuild
    .build(options)
    .then(() => syncBrowserSyncTemplates())
    .catch(() => process.exit(1));
}
