import { readFile } from 'node:fs/promises';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';

it.each([
  'billboard',
  'beam',
  'ribbon',
  'trail',
  'mesh',
  'billboard-inputs',
  'beam-inputs',
  'ribbon-inputs',
  'trail-inputs',
  'mesh-inputs',
])('validates atmospheric transport in the real %s particle module', async (name) => {
  const engine = await loadEngineShaderEntries();
  const source = await readFile(
    new URL(`../../../vfx-render/src/shaders/${name}.wgsl`, import.meta.url),
    'utf8',
  );
  const compiled = (
    await compileShader(source, {
      id: `particle-atmosphere-${name}`,
      imports: engine.imports,
      defines: { STORAGE_BUFFER_AVAILABLE: true, ATMOSPHERE_AVAILABLE: true },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('GPU unavailable');
  const device = await adapter.requestDevice();
  try {
    const module = device.createShaderModule({ code: compiled.wgsl });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
  } finally {
    device.destroy();
  }
});
