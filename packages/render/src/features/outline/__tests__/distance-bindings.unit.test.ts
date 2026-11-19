import { rhi } from '@forgeax/engine-rhi-null';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it, vi } from 'vitest';
import { buildFullscreenPostProcessPass } from '../../../fullscreen-post-process-pass';
import { DISTANCE_OUTLINE_PROGRAMS } from '../distance-shaders';

it.each(
  DISTANCE_OUTLINE_PROGRAMS.filter((program) =>
    program.reads?.some((read) => typeof read !== 'string' && read.sampleType === 'depth'),
  ),
)('matches native fullscreen depth and color bindings for $name', async (program) => {
  const compiled = await compileShader(program.source, {
    renderEntries: { vertex: 'vs_main', fragment: 'fs_main', colorFormats: ['rgba16float'] },
  });
  if (!compiled.ok) throw compiled.error;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layouts = vi.spyOn(device, 'createBindGroupLayout');
  const built = buildFullscreenPostProcessPass(
    {
      device,
      errorRegistry: {
        fire(error) {
          throw error;
        },
      },
    },
    program,
    program.name.endsWith('.msaa'),
  );
  expect(built).not.toBeNull();
  const layout = layouts.mock.calls.find(([descriptor]) =>
    Array.from(descriptor.entries).some(
      (entry) => entry.binding === 3 && entry.texture?.sampleType === 'depth',
    ),
  )?.[0];
  expect(layout).toBeDefined();
  const shaderLayout = compiled.value.bindings.find((group) =>
    group.entries.some((entry) => entry.binding === 3 && entry.texture?.sampleType === 'depth'),
  );
  expect(shaderLayout).toBeDefined();
  for (const entry of shaderLayout?.entries ?? []) {
    if (entry.texture === undefined) continue;
    const admitted = Array.from(layout?.entries ?? []).find(
      (candidate) => candidate.binding === entry.binding,
    )?.texture;
    expect(admitted, `texture binding ${entry.binding}`).toBeDefined();
    // A load-only float shader accepts either float layout capability; hardware
    // depth, uint and multisample requirements remain exact.
    if (entry.texture.sampleType === 'unfilterable-float')
      expect(['float', 'unfilterable-float']).toContain(admitted?.sampleType);
    else expect(admitted?.sampleType).toBe(entry.texture.sampleType);
    expect(admitted?.viewDimension ?? '2d').toBe(entry.texture.viewDimension ?? '2d');
    expect(admitted?.multisampled ?? false).toBe(entry.texture.multisampled ?? false);
  }
});
