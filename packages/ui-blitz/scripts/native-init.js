// Generated wrappers and finalizer above are unchanged. The host supplies the
// matching immutable packaged module and the instance's complete imports.
let initialization;
let initializationHost;
let terminalFailure;

export function initialize(host) {
  if (terminalFailure) return Promise.reject(terminalFailure);
  if (initializationHost && initializationHost !== host) {
    return Promise.reject(new Error('ui-wasm-host-mismatch: reuse the initialized realm host'));
  }
  if (initialization) return initialization;
  initializationHost = host;
  initialization = Promise.resolve().then(async () => {
    const bytes = await host.readWasm();
    const digest = Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256) {
      throw new Error('ui-wasm-integrity: bytes do not match the generated binding');
    }
    const imports = __wbg_get_imports();
    const result = await host.instantiate(imports);
    try {
      __wbg_finalize_init(result.instance, result.module);
    } catch (cause) {
      terminalFailure = new Error('ui-wasm-start-failed: create a fresh realm', { cause });
      throw terminalFailure;
    }
  }).catch(cause => {
    if (!terminalFailure) {
      initializationHost = undefined;
      initialization = undefined;
    }
    throw cause;
  });
  return initialization;
}
