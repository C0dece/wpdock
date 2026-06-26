/**
 * Fast ZIP pack/unpack built on fflate (pure JS, ~3x faster than extract-zip /
 * yauzl for our archives). Used for WordPress + portable runtime extraction and
 * for archive creation where the native bsdtar fast-path isn't available.
 */
import * as fs from 'fs';
import * as path from 'path';
import { unzipSync, zipSync } from 'fflate';

/**
 * Extracts `zipPath` into `destDir`. Decompresses in memory then writes files,
 * which avoids yauzl's per-entry stream overhead. Guards against zip-slip.
 */
export async function unzip(zipPath: string, destDir: string): Promise<void> {
  const data = await fs.promises.readFile(zipPath);
  unzipBuffer(data, destDir);
}

/** Extracts an in-memory ZIP buffer into `destDir`. Same guards as {@link unzip}. */
export function unzipBuffer(data: Uint8Array | Buffer, destDir: string): void {
  const entries = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));

  const createdDirs = new Set<string>();
  const ensureDir = (dir: string): void => {
    if (!createdDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDirs.add(dir);
    }
  };

  const root = path.resolve(destDir);
  ensureDir(root);

  for (const [name, content] of Object.entries(entries)) {
    const outPath = path.resolve(root, name);
    // Zip-slip: every entry must stay inside destDir.
    if (outPath !== root && !outPath.startsWith(root + path.sep)) {
      throw new Error(`Небезопасный путь в архиве: ${name}`);
    }
    if (name.endsWith('/')) { ensureDir(outPath); continue; }
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, content);
  }
}

/**
 * Packs the contents of `srcDir` into a ZIP at `destZip`.
 * `filter` receives the POSIX-style path relative to `srcDir`; return false to skip.
 * `level` 0 = store (no compression), 6 = default deflate.
 */
export async function zipDirectory(
  srcDir: string,
  destZip: string,
  opts: { level?: number; filter?: (relPath: string) => boolean } = {}
): Promise<void> {
  const level = opts.level ?? 6;
  const files: Record<string, Uint8Array> = {};

  const walk = (dir: string, base: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (opts.filter && !opts.filter(rel)) { continue; }
        files[rel] = new Uint8Array(fs.readFileSync(abs));
      }
    }
  };

  walk(srcDir, '');
  const zipped = zipSync(files, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });
  await fs.promises.writeFile(destZip, zipped);
}
