import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { cpuPhysicalRangesFixture } from './cpu-physical-ranges-fixture';
import { CPU_SETUP_SHADER } from './main-pass-cpu-setup-fixture';

it.each([
  'forward',
  'deferred',
  'temporal',
  'shadow',
] as const)('submits physical root and lower ranges through %s without changing source geometry', async (kind) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuPhysicalRangesFixture(device, shader);
  try {
    expect(f.firstMesh.vertexBuffer).toBe(f.secondMesh.vertexBuffer);
    expect(f.firstMesh.indexBuffer).toBe(f.secondMesh.indexBuffer);
    for (const profiled of [false, true]) {
      for (const level of [0, 1] as const) {
        const pass = device
          .createCommandEncoder()
          .unwrap()
          .beginRenderPass({ colorAttachments: [] });
        const draws = vi.spyOn(pass, 'drawIndexed');
        f.recordRange(pass, kind, level, profiled);
        expect(draws.mock.calls).toEqual([
          [3, 1, 0, 0, 0],
          [3, 1, level ? 6 : 3, level ? 5 : 2, 0],
        ]);
        expect(f.rows(level)[1]?.mesh.submeshes).toBe(f.sourceSubmeshes);
        expect(f.second.source.gpuDrivenDraws).toEqual(f.sourceDraws);
        pass.end();
      }
    }
    expect(f.errors).toEqual([]);
  } finally {
    f.dispose();
  }
});

it('keeps GPU claim identity local and restores the nonzero CPU fallback range', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuPhysicalRangesFixture(device, shader);
  try {
    for (const claimed of [true, false, true]) {
      f.claimSecond(claimed);
      const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
      const draws = vi.spyOn(pass, 'drawIndexed');
      f.recordRange(pass, 'forward', 0);
      expect(draws.mock.calls).toEqual(
        claimed
          ? [[3, 1, 0, 0, 0]]
          : [
              [3, 1, 0, 0, 0],
              [3, 1, 3, 2, 0],
            ],
      );
      pass.end();
    }
    expect(f.second.source.gpuDrivenDraws).toEqual(f.sourceDraws);
  } finally {
    f.dispose();
  }
});

it.each([
  'forward',
  'shadow',
] as const)('indexes %s ranges by source submesh across a compact publication and preserves signed baseVertex', async (kind) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuPhysicalRangesFixture(device, shader);
  try {
    const submesh = f.sourceSubmeshes[0];
    const draw = f.second.source.gpuDrivenDraws?.[0];
    if (submesh === undefined || draw === undefined) throw new Error('Expected source geometry');
    const submeshes = [submesh, { ...submesh, indexOffset: 3 }];
    Object.assign(f.secondMesh, {
      submeshes,
      lodRanges: [
        [
          { first: 6, count: 3, baseVertex: 5 },
          { first: 3, count: 6, baseVertex: -1 },
        ],
      ],
    });
    // Compact ordinal 0 identifies source submesh 1. Both explicit and
    // legacy matching must retain that source domain for resident ranges.
    for (const stable of [true, false]) {
      const { drawItemIndex: _index, ...legacy } = draw;
      const publication = [{ ...legacy, first: 3, ...(stable ? { drawItemIndex: 1 } : {}) }];
      Object.assign(f.second.source, { gpuDrivenDraws: publication });
      const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
      const draws = vi.spyOn(pass, 'drawIndexed');
      f.recordRange(pass, kind, 0);
      expect(draws.mock.calls).toEqual([
        [3, 1, 0, 0, 0],
        [3, 1, 6, 5, 0],
        [6, 1, 3, -1, 0],
      ]);
      expect(f.secondMesh.submeshes).toBe(submeshes);
      expect(f.second.source.gpuDrivenDraws).toBe(publication);
      pass.end();
    }
    expect(f.errors).toEqual([]);
  } finally {
    f.dispose();
  }
});
