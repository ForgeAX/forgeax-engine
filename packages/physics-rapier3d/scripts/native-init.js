// Appended to the pinned generated glue; its imports and finalizer own the ABI.
let nativePending;

export function initializeNative(host) {
  return (nativePending ??= (async () => {
    const bytes = await host.readWasm();
    const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256)
      throw new Error('Native Rapier WASM differs from its published glue');
    if (typeof host.now !== 'function') throw new TypeError('Native Rapier Host requires a monotonic millisecond clock');
    const clock = Object.freeze({ now: () => host.now() });
    const imports = __wbg_get_imports();
    // web-time expects a Performance object, encoded through this exact generated heap ABI.
    // Keep the clock inside this module; native Hosts need no browser performance global.
    imports['./rapier_wasm3d_bg.js'].__wbg_performance_3fcf6e32a7e1ed0a = () => addHeapObject(clock);
    const result = await host.instantiate(imports);
    // This qualified ABI has no Rust start function; adoption remains retryable.
    return __wbg_finalize_init(result.instance, result.module);
  })().catch((cause) => {
    nativePending = undefined;
    throw cause;
  }));
}
