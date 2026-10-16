// Appended by native-build.mjs to the verified wasm-bindgen module.
// __wbg_get_imports and __wbg_finalize_init remain owned by generated glue.
let nativeHost;
let nativeReady;
let nativeTerminalFailure;

function nativeInitializationError(operation, cause) {
  return Object.assign(new Error(`wgpu native initialization failed: ${operation}`, { cause }), {
    code: 'wgpu-native-initialization-failed',
    operation,
  });
}

/** One native initializer per module/realm; no browser globals are replaced. */
export function initializeNativeWgpu(host) {
  if (nativeHost !== undefined && nativeHost !== host) {
    return Promise.reject(nativeInitializationError('host-identity', 'use the original host lease'));
  }
  if (nativeTerminalFailure !== undefined) return Promise.reject(nativeTerminalFailure);
  if (nativeReady !== undefined) return nativeReady;
  nativeHost = host;
  nativeReady = Promise.resolve().then(async () => {
    const canvases = new Set();
    const contexts = new Set();
    if (!Array.isArray(host.surfaces) || host.surfaces.length === 0) {
      throw nativeInitializationError('surface-admission', 'supply at least one native canvas');
    }
    for (const canvas of host.surfaces) {
      const context = canvas.getContext('webgl2', {
        alpha: true, antialias: false, premultipliedAlpha: true,
        preserveDrawingBuffer: false, powerPreference: 'default',
      });
      if (context === null || !/^WebGL 2\.0\b/.test(context.getParameter(context.VERSION))) {
        throw nativeInitializationError('surface-admission', 'native canvas has no WebGL2 context');
      }
      canvases.add(canvas);
      contexts.add(context);
    }
    const bytes = await host.readWasm();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== nativeArtifact.bytes ||
        nativeSha256(bytes) !== nativeArtifact.sha256) {
      throw nativeInitializationError('artifact-integrity', 'packaged WASM differs from its producer');
    }
    const imports = __wbg_get_imports();
    const bindings = imports['./wgpu_wasm_bg.js'];
    for (const [prefix, admitted] of [
      ['__wbg_instanceof_HtmlCanvasElement_', canvases],
      ['__wbg_instanceof_WebGl2RenderingContext_', contexts],
    ]) {
      const names = Object.keys(bindings).filter(name => name.startsWith(prefix));
      if (names.length !== 1) throw nativeInitializationError('glue-abi', prefix);
      const original = bindings[names[0]];
      // Preserve real browser constructors for external image sources. Native
      // surfaces still need exact identity admission when those globals are absent.
      bindings[names[0]] = value => admitted.has(value) || original(value);
    }
    const profileQueries = Object.keys(bindings).filter(name => name.startsWith('__wbg_getSupportedProfiles_'));
    if (profileQueries.length !== 1) throw nativeInitializationError('glue-abi', 'ASTC profile query');
    const profiles = bindings[profileQueries[0]];
    // Some native WebGL hosts expose ASTC without its profile query. The pinned
    // ABI's zero means None: glow declines both profiles without inventing support.
    bindings[profileQueries[0]] = extension => typeof extension.getSupportedProfiles === 'function'
      ? profiles(extension) : 0;
    const result = await host.instantiate(imports);
    try {
      return __wbg_finalize_init(result.instance, result.module);
    } catch (cause) {
      // Startup can partially initialize Rust state. A fresh realm is required;
      // only failures before finalization may safely retry in the same module.
      nativeTerminalFailure = nativeInitializationError('wasm-start', cause);
      throw nativeTerminalFailure;
    }
  }).catch(cause => {
    if (nativeTerminalFailure === undefined) {
      nativeHost = undefined;
      nativeReady = undefined;
    }
    throw cause?.code === 'wgpu-native-initialization-failed'
      ? cause : nativeInitializationError('native-host', cause);
  });
  return nativeReady;
}
