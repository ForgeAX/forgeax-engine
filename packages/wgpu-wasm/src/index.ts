// packages/wgpu-wasm/src/index.ts — ensureReady singleton wrapper (plan-strategy D-P3 /
// research F-4).
//
// SSOT for wasm init across all consumers (@forgeax/engine-rhi-wgpu + @forgeax/engine-naga thin shells).
// The single-Promise cache + null-reset-on-rejection semantics is required so that:
//
// 1. Multiple thin shells calling ensureReady() concurrently share one wasm instance
//    (charter proposition 6 Idempotency: reference equality across calls).
// 2. The wasm boundary is crossed exactly once per page lifecycle — a second call
//    after success returns the same wasm namespace without re-running init().
// 3. A transient init failure (e.g. fetch jitter) null-resets the cached Promise;
//    subsequent calls re-attempt _loadWasm() (charter proposition 4 explicit failure:
//    the original error is surfaced on each attempt, but the caller may retry).
//
// Three-scenario wasm asset resolution (research F-4):
// - Browser / Vite: generated glue is fetched through Vite's ?raw form so its
//   source bytes remain identical to the provenance manifest.
// - Node runtime (no Vite): detected via process.versions.node + absent document;
//   the wasm bytes are read via fs.readFile relative to import.meta.url.
// - vitest node environment: the ?url import resolves through Vite's bundler to a
//   file:// URL, but the Node branch above takes precedence so the wasm bytes are
//   loaded synchronously before init().

import init, * as wasm from '../pkg/wgpu_wasm.js';

/**
 * The typed wasm namespace surface (camelCase per wasm-bindgen `js_name` rewrites).
 *
 * Consumers (@forgeax/engine-rhi-wgpu / @forgeax/engine-naga thin shells) destructure or call
 * methods directly: `const adapter = await wasm.RhiWgpuInstance.create()`,
 * `const parsed = wasm.parse(source)`, etc.
 */
export type WgpuWasm = typeof wasm;

interface LoadedWasm {
  readonly wasm: WgpuWasm;
  readonly compilerFingerprint: string;
}

/** One load owns both native execution and its verified identity. */
interface WasmLoad {
  readonly loaded: Promise<LoadedWasm>;
  readonly ready: Promise<WgpuWasm>;
}

/** @internal */
let _instance: WasmLoad | null = null;

/**
 * Initialise the merged wgpu + naga wasm module (or return the cached instance).
 *
 * Idempotent: N calls return the same Promise reference. The Promise resolves to
 * the same wasm namespace reference across N awaits (charter proposition 6).
 *
 * Null-reset on transient failure: if the underlying `init(wasmUrl)` rejects,
 * the cached Promise is cleared (set to null) so the next call retries
 * `_loadWasm()` (charter proposition 4 explicit failure; transient errors such
 * as fetch jitter are recoverable by the caller without manual reset).
 */
// Avoid @types/node devDep (mirror @forgeax/engine-math + @forgeax/engine-shader-compiler strategy).
// The process value on globalThis is fetched via an unknown bridge; runtime detection
// plus the dynamic import('node:*') module id are transparent to ts-strict.
interface NodeProcessLike {
  readonly versions?: { readonly node?: string };
}
interface NodeFsLike {
  readFile(path: string): Promise<Uint8Array>;
}
interface NodeUrlLike {
  fileURLToPath(url: URL): string;
}

interface WasmProvenance {
  readonly schemaVersion: 'wgpu-wasm-provenance/1';
  readonly sourceContentKey: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly glueSha256: string;
  readonly glueBytes: number;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly compilerFingerprint: string;
}

interface NodeCryptoLike {
  createHash(name: string): {
    update(value: Uint8Array | string): {
      digest(encoding: 'hex'): string;
    };
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  const cryptoModuleId = 'node:crypto';
  const crypto = (await import(/* @vite-ignore */ cryptoModuleId)) as unknown as NodeCryptoLike;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function provenanceFingerprintInput(manifest: WasmProvenance): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceContentKey: manifest.sourceContentKey,
    artifactSha256: manifest.artifactSha256,
    glueSha256: manifest.glueSha256,
    toolchain: manifest.toolchain,
    dependencies: manifest.dependencies,
  });
}

async function verifyProvenance(
  manifestBytes: Uint8Array,
  artifactBytes: Uint8Array,
  glueBytes: Uint8Array,
): Promise<WasmProvenance> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error('wgpu-wasm provenance manifest is not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 'wgpu-wasm-provenance/1'
  ) {
    throw new Error('wgpu-wasm provenance manifest has an unsupported schemaVersion');
  }
  const manifest = parsed as WasmProvenance;
  const artifactSha256 = await sha256Hex(artifactBytes);
  const glueSha256 = await sha256Hex(glueBytes);
  if (
    artifactSha256 !== manifest.artifactSha256 ||
    artifactBytes.byteLength !== manifest.artifactBytes
  ) {
    throw new Error('wgpu-wasm artifact bytes do not match provenance manifest');
  }
  if (glueSha256 !== manifest.glueSha256 || glueBytes.byteLength !== manifest.glueBytes) {
    throw new Error('wgpu-wasm glue bytes do not match provenance manifest');
  }
  const fingerprint = `sha256-${await sha256Hex(
    new TextEncoder().encode(provenanceFingerprintInput(manifest)),
  )}`;
  if (fingerprint !== manifest.compilerFingerprint) {
    throw new Error('wgpu-wasm compiler fingerprint does not match provenance manifest');
  }
  return manifest;
}

function rawGluePath(path: URL): URL {
  const rawPath = new URL(path.href);
  rawPath.search = `${rawPath.search}${rawPath.search === '' ? '?' : '&'}raw`;
  return rawPath;
}

async function readBrowserGlueBytes(response: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const prefix = 'export default ';
  if (!text.startsWith(prefix)) {
    return bytes;
  }

  // Vite's ?raw module wraps the original source as a JSON string. Decode the
  // wrapper before hashing; a static server that ignores the query returns the
  // original glue bytes and takes the branch above.
  let payload = text.slice(prefix.length).trim();
  if (payload.endsWith(';')) {
    payload = payload.slice(0, -1).trim();
  }
  try {
    const decoded = JSON.parse(payload) as unknown;
    if (typeof decoded === 'string') {
      return new TextEncoder().encode(decoded);
    }
  } catch {
    // Leave malformed or non-Vite responses untouched so provenance rejects
    // them instead of allowing an integrity check bypass.
  }
  return bytes;
}

async function _loadWasm(): Promise<LoadedWasm> {
  // Branch: Node when process.versions.node exists. Browser path is the default
  // wasm-bindgen fetch via URL assets; Vite's raw wrapper is normalized below.
  const proc = (globalThis as unknown as { process?: NodeProcessLike }).process;
  const isNode = typeof proc?.versions?.node === 'string';

  // Reach packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm relative to this module
  // (src/index.ts during vitest; dist/index.mjs after tsup build — both sit
  // one directory up from pkg/). This URL form works in both Node and browser
  // import.meta contexts and avoids a Vite-only top-level `?url` import (which
  // Node interprets as a wasm module import).
  const wasmPath = new URL('../pkg/wgpu_wasm_bg.wasm', import.meta.url);
  const manifestPath = new URL('../pkg/provenance.json', import.meta.url);
  const gluePath = new URL('../pkg/wgpu_wasm.js', import.meta.url);

  let provenance: WasmProvenance;
  if (isNode) {
    // Dynamic imports via string literals avoid triggering missing @types/node
    // errors during ts static resolution.
    const fsModuleId = 'node:fs/promises';
    const urlModuleId = 'node:url';
    const fs = (await import(/* @vite-ignore */ fsModuleId)) as NodeFsLike;
    const url = (await import(/* @vite-ignore */ urlModuleId)) as NodeUrlLike;
    const wasmBytes = await fs.readFile(url.fileURLToPath(wasmPath));
    const manifestBytes = await fs.readFile(url.fileURLToPath(manifestPath));
    const glueBytes = await fs.readFile(url.fileURLToPath(gluePath));
    provenance = await verifyProvenance(manifestBytes, wasmBytes, glueBytes);
    await init({ module_or_path: wasmBytes });
  } else {
    const [manifestResponse, wasmResponse, glueResponse] = await Promise.all([
      fetch(manifestPath),
      fetch(wasmPath),
      fetch(rawGluePath(gluePath)),
    ]);
    if (!manifestResponse.ok || !wasmResponse.ok || !glueResponse.ok) {
      throw new Error('wgpu-wasm provenance or generated bytes could not be fetched');
    }
    const [manifestBytes, wasmBytes, glueBytes] = await Promise.all([
      manifestResponse.arrayBuffer(),
      wasmResponse.arrayBuffer(),
      readBrowserGlueBytes(glueResponse),
    ]);
    provenance = await verifyProvenance(
      new Uint8Array(manifestBytes),
      new Uint8Array(wasmBytes),
      new Uint8Array(glueBytes),
    );
    await init({ module_or_path: wasmBytes });
  }
  return { wasm: wasm as WgpuWasm, compilerFingerprint: provenance.compilerFingerprint };
}

function currentLoad(): WasmLoad {
  if (!_instance) {
    const loaded: Promise<LoadedWasm> = _loadWasm().catch((e: unknown) => {
      if (_instance === owner) _instance = null;
      throw e;
    });
    const ready = loaded.then((value) => value.wasm);
    // Identity-only callers observe loaded. Preserve ready's rejection for
    // execution callers without an unobserved derived-Promise rejection.
    void ready.catch(() => {});
    const owner: WasmLoad = { loaded, ready };
    _instance = owner;
  }
  return _instance;
}

export const ensureReady = (): Promise<WgpuWasm> => currentLoad().ready;

/** Identity of the successfully initialized native compiler, never a disk-only claim. */
export const getCompilerFingerprint = async (): Promise<string> =>
  (await currentLoad().loaded).compilerFingerprint;

/**
 * Test-only: reset the cached instance so a subsequent ensureReady() re-runs init().
 *
 * NOT exported from the package root — consumers should NEVER reset; this helper
 * exists only so the per-package vitest suite can exercise the failure-mode case
 * without process restart. Imported via the relative path inside test files.
 */
export const __resetForTests = (): void => {
  _instance = null;
};
