// Dawn's native binding fills omitted required limits from wgpu::Limits::default().
// That default uses 1,000,000 dynamic buffers, while the lavapipe adapter in CI
// exposes a much smaller real limit. Dawn then emits a warning and clamps the
// request. Supplying the adapter's actual value for omitted fields and the
// synthetic 1,000,000 default keeps the descriptor within the adapter contract
// without mutating the caller's object or hiding a meaningful requirement.

const dynamicLimitKeys = Object.freeze([
  'maxDynamicUniformBuffersPerPipelineLayout',
  'maxDynamicStorageBuffersPerPipelineLayout',
]);
const syntheticDawnDynamicLimitDefault = 1_000_000;
const patchedAdapterMethods = new WeakSet();
const patchedGpuMethods = new WeakSet();
const normalizedAdapters = new WeakMap();

export function normalizeDawnDeviceDescriptor(adapter, descriptor) {
  const adapterLimits = adapter?.limits;
  if (adapterLimits === undefined || adapterLimits === null) return descriptor;
  const requiredLimits = { ...(descriptor?.requiredLimits ?? {}) };
  let changed = false;
  for (const key of dynamicLimitKeys) {
    const value = adapterLimits[key];
    if (!Number.isFinite(value) || value < 1) continue;
    const requested = requiredLimits[key];
    if (
      requested !== undefined &&
      (requested <= value || requested !== syntheticDawnDynamicLimitDefault)
    ) {
      continue;
    }
    requiredLimits[key] = value;
    changed = true;
  }
  if (!changed) return descriptor;
  return { ...(descriptor ?? {}), requiredLimits };
}

/**
 * Normalize one adapter even when the native binding exposes requestDevice as
 * an own, non-configurable method instead of a mutable prototype method. The
 * Linux Dawn binding has used both shapes across releases; a Proxy fallback
 * keeps the contract stable without mutating native objects that reject a
 * property replacement.
 */
export function normalizeDawnAdapter(adapter) {
  if (adapter === undefined || adapter === null || typeof adapter.requestDevice !== 'function') {
    return adapter;
  }
  const existing = normalizedAdapters.get(adapter);
  if (existing !== undefined) return existing;
  const original = adapter.requestDevice;
  const normalizedRequestDevice = function requestDeviceWithAdapterLimits(descriptor) {
    return original.call(adapter, normalizeDawnDeviceDescriptor(adapter, descriptor));
  };
  let normalized = adapter;
  try {
    Object.defineProperty(adapter, 'requestDevice', {
      configurable: true,
      value: normalizedRequestDevice,
      writable: true,
    });
    if (adapter.requestDevice !== normalizedRequestDevice)
      throw new Error('native method remained unchanged');
  } catch {
    // A Proxy cannot override a frozen, non-configurable function property
    // without violating the Proxy invariants. Forward through an empty target
    // instead; native getters/methods still receive the original adapter as
    // their receiver while requestDevice is replaced by the normalized hook.
    normalized = new Proxy(Object.create(Object.getPrototypeOf(adapter)), {
      get(_target, property) {
        if (property === 'requestDevice') return normalizedRequestDevice;
        return Reflect.get(adapter, property, adapter);
      },
      set(_target, property, value) {
        return Reflect.set(adapter, property, value, adapter);
      },
    });
  }
  normalizedAdapters.set(adapter, normalized);
  return normalized;
}

export function patchDawnAdapterPrototype(globals) {
  const adapterPrototype = globals?.GPUAdapter?.prototype;
  let patched = false;
  if (adapterPrototype !== undefined && typeof adapterPrototype.requestDevice === 'function') {
    const original = adapterPrototype.requestDevice;
    if (!patchedAdapterMethods.has(original)) {
      const wrapped = function requestDeviceWithAdapterLimits(descriptor) {
        return original.call(this, normalizeDawnDeviceDescriptor(this, descriptor));
      };
      try {
        Object.defineProperty(adapterPrototype, 'requestDevice', {
          configurable: true,
          value: wrapped,
          writable: true,
        });
        patchedAdapterMethods.add(wrapped);
      } catch {
        // The GPU prototype hook below still covers bindings with a locked
        // adapter method by returning a normalized adapter proxy.
      }
    }
    patched = true;
  }
  const gpuPrototype = globals?.GPU?.prototype;
  if (gpuPrototype !== undefined && typeof gpuPrototype.requestAdapter === 'function') {
    const original = gpuPrototype.requestAdapter;
    if (!patchedGpuMethods.has(original)) {
      const wrapped = async function requestAdapterWithNormalizedDeviceLimits(...args) {
        const adapter = await original.apply(this, args);
        return normalizeDawnAdapter(adapter);
      };
      try {
        Object.defineProperty(gpuPrototype, 'requestAdapter', {
          configurable: true,
          value: wrapped,
          writable: true,
        });
        patchedGpuMethods.add(wrapped);
      } catch {
        // setup-webgpu.ts also normalizes the returned adapter at its local
        // GPU instance boundary when a native prototype is locked.
      }
    }
    patched = true;
  }
  return patched;
}
