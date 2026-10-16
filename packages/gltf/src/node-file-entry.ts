// File-entry wrappers (Node-only, dynamic-import isolated).
//
// `parseGltfFromFile` / `parseGlbFromFile` are the only members of this
// package that touch the filesystem. They live in this dedicated module so
// the main entry (`index.ts`) stays browser-clean: the `node:fs/promises`
// and `node:path` dynamic imports below would otherwise trip vite's
// "module externalized for browser compatibility" warning when the demo
// bundles `@forgeax/engine-gltf` for the browser even though it never
// calls these helpers.
//
// Sidecar policy (feat-20260521 unify-sidecar-meta-dispatch-by-content):
//   <name>.gltf -> <name>.gltf.meta.json
//   <name>.glb  -> <name>.glb.meta.json
//
// Both wrappers add a single fail-fast pre-step: stat the sibling
// `<source>.meta.json`; return `gltf-meta-missing` if absent (same code
// surfaced by the vite-plugin and the console CLI dry-run, charter
// proposition 5 consistent abstraction). Callers with an ArrayBuffer /
// parsed JSON should keep using `parseGltf` / `parseGlb` directly.

import { err, type GltfError, gltfErr, type Result } from './errors.js';
import { type ExternalLoader, type GltfDoc, parseGlb, parseGltf } from './parse-gltf.js';

interface FsLike {
  readonly stat: (path: string) => Promise<unknown>;
  readonly readFile: (path: string) => Promise<Buffer>;
}

interface PathLike {
  readonly dirname: (p: string) => string;
  readonly resolve: (...segments: string[]) => string;
}

async function loadFsModule(): Promise<FsLike> {
  const mod = (await import('node:fs/promises')) as unknown as FsLike;
  return mod;
}

async function loadPathModule(): Promise<PathLike> {
  const mod = (await import('node:path')) as unknown as PathLike;
  return mod;
}

async function statExists(fs: FsLike, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function metaPathFor(filePath: string): string {
  return `${filePath}.meta.json`;
}

/**
 * Parse a `.gltf` file from disk. Pre-step: stat the sibling
 * `<source>.meta.json`; if missing, return `gltf-meta-missing` without
 * reading the source bytes.
 */
export async function parseGltfFromFile(filePath: string): Promise<Result<GltfDoc, GltfError>> {
  const fs = await loadFsModule();
  const path = await loadPathModule();
  const expectedMetaPath = metaPathFor(filePath);
  if (!(await statExists(fs, expectedMetaPath))) {
    return err(gltfErr('gltf-meta-missing', { filePath, expectedMetaPath }));
  }
  const text = (await fs.readFile(filePath)).toString('utf-8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (_e) {
    return err(gltfErr('gltf-malformed-header', { filePath, byteOffset: 0 }));
  }
  const baseDir = path.dirname(filePath);
  const externalLoader: ExternalLoader = async (uri: string) => {
    const abs = path.resolve(baseDir, uri);
    const buf = await fs.readFile(abs);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
  return parseGltf(json, externalLoader, filePath);
}

/**
 * Parse a `.glb` file from disk. Same fail-fast meta-stat pre-step as
 * `parseGltfFromFile`.
 */
export async function parseGlbFromFile(filePath: string): Promise<Result<GltfDoc, GltfError>> {
  const fs = await loadFsModule();
  const expectedMetaPath = metaPathFor(filePath);
  if (!(await statExists(fs, expectedMetaPath))) {
    return err(gltfErr('gltf-meta-missing', { filePath, expectedMetaPath }));
  }
  const buf = await fs.readFile(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return parseGlb(ab, filePath);
}
