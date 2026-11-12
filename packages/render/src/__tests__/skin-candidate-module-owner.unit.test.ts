import { err, type RhiDevice, RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ShaderSource } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import { RhiErrorListenerRegistry } from '../lifecycle';

const code = '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';

async function fixture(device?: RhiDevice) {
  device ??= (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failed = false;
  const compile = vi.fn(async (...args: Parameters<typeof rhi.createShaderModule>) => {
    const result = await rhi.createShaderModule(...args);
    await gate;
    return failed
      ? err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'controlled failed validation',
            hint: 'retain failure',
          }),
        )
      : result;
  });
  const immediateCompile = vi.fn(rhi.createShaderModuleImmediate);
  const validated = makeShaderDeviceAdapter(
    device,
    new RhiErrorListenerRegistry(),
    compile,
    undefined,
  );
  const immediate = makeShaderDeviceAdapter(
    device,
    new RhiErrorListenerRegistry(),
    undefined,
    immediateCompile,
    'immediate',
    (key, source) => validated.completedModule?.(key, source),
  );
  const source = new ShaderSource([code]);
  const label = 'skin-candidate-shadow';
  const descriptor = source.descriptor(label);
  const complete = async () => {
    release();
    for (let turn = 0; turn < 32; turn++) {
      await Promise.resolve();
      const module = validated.completedModule?.(label, source);
      if (module !== undefined) return module;
    }
    // The original adapter exposes readiness through the actual retry API.
    return validated.createShaderModule(descriptor).unwrap();
  };
  return {
    device,
    source,
    descriptor,
    label,
    validated,
    immediate,
    compile,
    immediateCompile,
    complete,
    fail: () => {
      failed = true;
    },
    release,
    dispose: () => {
      release();
      immediate.dispose();
      validated.dispose();
    },
  };
}

it('uses the completed validated native module for the immediate draw without another compile', async () => {
  const f = await fixture();
  try {
    expect(f.validated.createShaderModule(f.descriptor).ok).toBe(false);
    const ready = await f.complete();
    expect(f.immediate.createShaderModule(f.descriptor).unwrap()).toBe(ready);
    expect(f.compile).toHaveBeenCalledTimes(1);
    expect(f.immediateCompile).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('never reports pending or failed validation as a completed module', async () => {
  const f = await fixture();
  try {
    expect(f.validated.createShaderModule(f.descriptor).ok).toBe(false);
    expect(f.validated.completedModule(f.label, f.source)).toBeUndefined();
    f.fail();
    f.release();
    for (let turn = 0; turn < 32; turn++) await Promise.resolve();
    expect(f.validated.createShaderModule(f.descriptor).ok).toBe(false);
    expect(f.validated.completedModule(f.label, f.source)).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it.each([
  'source',
  'invalidate',
  'dispose',
] as const)('does not cache a borrowed module across validated %s changes', async (edit) => {
  const f = await fixture();
  try {
    f.validated.createShaderModule(f.descriptor);
    const ready = await f.complete();
    expect(f.immediate.createShaderModule(f.descriptor).unwrap()).toBe(ready);
    let descriptor = f.descriptor;
    if (edit === 'source')
      descriptor = new ShaderSource([code.replace('0.0', '1.0')]).descriptor(f.label);
    else if (edit === 'invalidate') f.validated.invalidateModule(f.label);
    else f.validated.dispose();
    expect(f.immediate.createShaderModule(descriptor).unwrap()).not.toBe(ready);
    expect(f.immediateCompile).toHaveBeenCalledTimes(1);
  } finally {
    f.dispose();
  }
});

it('keeps completed module ownership in its actual device generation', async () => {
  const first = await fixture(),
    second = await fixture();
  try {
    first.validated.createShaderModule(first.descriptor);
    second.validated.createShaderModule(second.descriptor);
    const a: ShaderModule = await first.complete(),
      b = await second.complete();
    expect(a).not.toBe(b);
    expect(first.immediate.createShaderModule(first.descriptor).unwrap()).toBe(a);
    expect(second.immediate.createShaderModule(second.descriptor).unwrap()).toBe(b);
    first.dispose();
    expect(first.immediate.createShaderModule(first.descriptor).ok).toBe(false);
    expect(second.immediate.createShaderModule(second.descriptor).unwrap()).toBe(b);
  } finally {
    first.dispose();
    second.dispose();
  }
});
