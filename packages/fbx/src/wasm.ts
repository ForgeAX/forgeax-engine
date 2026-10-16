/**
 * @forgeax/engine-fbx WASM runtime: initFbxWasm / parseFbx over the ufbx
 * emcc glue. Both browser and Node resolve through the same self-loading glue.
 *
 * WASM asset resolution (mirrors @forgeax/engine-wgpu-wasm):
 * - Browser / Vite: new URL() resolves to a fetch-able asset URL.
 * - Node runtime: the emcc glue is built with ENVIRONMENT=web,node, so it
 *   self-loads the .wasm via fs from the locateFile URL — no manual
 *   fs.readFile + wasmBinary hand-off in this layer (Derive, Don't Duplicate).
 * - vitest: runs under Node; same self-load path.
 */

// The emcc glue (pkg/fbx-wasm.mjs) is a gitignored build artifact — present only
// after build:wasm / fetch-wasm. It is imported LAZILY inside _loadWasm (not at
// module top level) so that merely importing @forgeax/engine-fbx — e.g. the
// studio editor-core barrel re-exporting cookFbxMeta, or the hermetic
// barrel-export-contract test (bun test, no wasm build) — does NOT require the
// built artifact. The glue is only needed once a caller invokes initFbxWasm().
type CreateFbxModule = (opts?: Record<string, unknown>) => Promise<FbxWasmModule>;

/* ── Types ─────────────────────────────────────────────────────────── */

interface FbxWasmModule {
  /** @internal emcc-exported C entry: parse FBX bytes at ptr into internal result buffer. */
  _parseFbxWasm(ptr: number, size: number): void;
  /** @internal emcc-exported C entry: pointer to the result JSON string. */
  _getResultPtr(): number;
  /** @internal emcc-exported C entry: byte length of the result JSON string. */
  _getResultLen(): number;
  /** @internal emcc-exported C entry: free the result buffer. */
  _freeResult(): void;
  /** @internal emscripten runtime: allocate `size` bytes in the wasm heap. */
  _malloc(size: number): number;
  /** @internal emscripten runtime: free a wasm-heap pointer. */
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number, maxLen?: number): string;
}

let wasmModule: FbxWasmModule | null = null;
let initPromise: Promise<FbxWasmModule> | null = null;

/* ── Internal loader ───────────────────────────────────────────────── */

async function _loadWasm(overrideUrl?: string): Promise<FbxWasmModule> {
  // Lazy-load the emcc glue only now that a caller actually wants the wasm.
  // @vite-ignore keeps the bundler from eagerly resolving the (possibly unbuilt)
  // artifact at import-graph time; it resolves at call time in every scenario
  // (browser/Vite, Node, vitest) exactly as the old top-level import did.
  const glueId = '../pkg/fbx-wasm.mjs';
  const createModule = ((await import(/* @vite-ignore */ glueId)) as { default: CreateFbxModule })
    .default;

  // The emcc glue (ENVIRONMENT=web,node) self-loads the .wasm from this URL:
  // via fetch() in the browser, via fs in Node. We only tell it where to look.
  const wasmAssetUrl = overrideUrl
    ? new URL(overrideUrl, import.meta.url)
    : new URL('../pkg/fbx-wasm.wasm', import.meta.url);

  const opts: Record<string, unknown> = {
    locateFile: () => wasmAssetUrl.href,
  };

  try {
    return await createModule(opts);
  } catch (cause) {
    throw new Error(
      `@forgeax/engine-fbx: failed to load WASM from ${wasmAssetUrl.href}. ` +
        'pkg/fbx-wasm.wasm may be missing. Self-help: ' +
        '(1) fetch a prebuilt artifact via `pnpm -F @forgeax/engine-fbx fetch-wasm`, or ' +
        '(2) compile locally with emcc via `pnpm -F @forgeax/engine-fbx build:wasm`.',
      { cause },
    );
  }
}

/* ── Public API ────────────────────────────────────────────────────── */

/**
 * Initialize the WASM module. Must be called once before `parseFbx`.
 * Safe to call multiple times (idempotent). Null-resets on failure so
 * transient errors (e.g. fetch jitter) are retryable.
 *
 * @param wasmUrl — optional override URL for the .wasm file
 */
export async function initFbxWasm(wasmUrl?: string): Promise<void> {
  if (wasmModule) return;

  if (!initPromise) {
    initPromise = _loadWasm(wasmUrl).catch((e: unknown) => {
      initPromise = null;
      throw e;
    });
  }

  wasmModule = await initPromise;
}

/**
 * Parse an FBX file in-memory and return the JSON POD string.
 *
 * The returned JSON follows the engine FBX POD schema, containing:
 * meshes, nodes, materials, skeletons, skins, clips.
 *
 * @param fbxBytes — raw FBX file bytes (binary or ASCII)
 * @returns JSON string matching the engine's FBX POD schema
 * @throws if WASM module is not initialized or parse fails
 */
export function parseFbx(fbxBytes: Uint8Array): string {
  if (!wasmModule) {
    throw new Error('@forgeax/engine-fbx: WASM not initialized. Call initFbxWasm() first.');
  }

  const mod = wasmModule;
  const size = fbxBytes.byteLength;

  const ptr = mod._malloc(size);
  if (!ptr) throw new Error('fbx-wasm: malloc failed for input buffer');

  try {
    mod.HEAPU8.set(fbxBytes, ptr);
    mod._parseFbxWasm(ptr, size);
  } finally {
    mod._free(ptr);
  }

  const resultPtr = mod._getResultPtr();
  const resultLen = mod._getResultLen();

  if (!resultPtr || !resultLen) {
    mod._freeResult();
    throw new Error('fbx-wasm: parseFbxWasm returned empty result');
  }

  // Decode via a fresh sliced copy, NOT mod.UTF8ToString. Under
  // ALLOW_MEMORY_GROWTH=1 the emcc glue backs HEAPU8 with a *resizable*
  // ArrayBuffer (wasmMemory.toResizableBuffer()); glue's UTF8ArrayToString then
  // calls TextDecoder.decode(HEAPU8.subarray(...)), which modern Chromium
  // rejects ("The provided ArrayBuffer value must not be resizable"). HEAPU8
  // .slice() returns a copy backed by a plain, non-resizable ArrayBuffer, so the
  // decode is accepted in every environment (browser/Vite, Node, vitest).
  const bytes = mod.HEAPU8.slice(resultPtr, resultPtr + resultLen);
  mod._freeResult();
  const json = new TextDecoder().decode(bytes);

  const firstChars = json.substring(0, 30);
  if (firstChars.includes('"error"')) {
    const parsed = JSON.parse(json);
    if (parsed.error) {
      throw new Error(`fbx-wasm: ${parsed.error.message || 'parse failed'}`);
    }
  }

  return json;
}

/**
 * Convenience: parse FBX bytes and return the parsed POD object.
 */
export function parseFbxToObject(fbxBytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(parseFbx(fbxBytes));
}

/**
 * Check if the WASM module is ready.
 */
export function isFbxWasmReady(): boolean {
  return wasmModule !== null;
}
