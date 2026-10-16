import { readFile } from 'node:fs/promises';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';

it('validates per-particle Standard color with direct and clustered lighting on Dawn', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const engine = await loadEngineShaderEntries();
  try {
    for (const name of ['mesh', 'mesh-inputs']) {
      const source = await readFile(
        new URL(`../../../vfx-render/src/shaders/${name}.wgsl`, import.meta.url),
        'utf8',
      );
      for (const clustered of [false, true]) {
        const compiled = await compileShader(source, {
          id: name,
          imports: engine.imports,
          defines: {
            STORAGE_BUFFER_AVAILABLE: true,
            CLUSTER_FORWARD_AVAILABLE: clustered,
            EXTENDED_LIGHTING_AVAILABLE: true,
            DIRECTIONAL_PCSS_AVAILABLE: true,
            PROJECTOR_AVAILABLE: true,
          },
        });
        if (!compiled.ok) throw new Error(compiled.error.message);
        const module = device.createShaderModule({ code: compiled.value.wgsl });
        const info = await module.getCompilationInfo();
        expect(
          info.messages
            .filter((message) => message.type === 'error')
            .map((message) => message.message),
        ).toEqual([]);
      }
    }
  } finally {
    device.destroy();
  }
}, 60_000);
