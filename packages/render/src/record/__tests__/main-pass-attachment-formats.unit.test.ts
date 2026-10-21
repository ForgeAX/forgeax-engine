import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { recordGeometryDraws } from '../main-pass-geometry';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

it('shares ordered deferred attachment arguments across mixed shaders only within one record pass', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 1 });
  const other = f.add({ entity: 2, submeshes: 1 });
  other.source.material.adopt({
    ...other.source.material.snapshot,
    materialShaderId: 'test::other-material',
  });
  f.add({ entity: 3, submeshes: 1 });
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const record = (formats: readonly GPUTextureFormat[]) => {
    f.acceptMaterials();
    const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
    try {
      recordGeometryDraws(
        f.c,
        pass,
        null,
        [[0], [0], [0]],
        1,
        f.meshGroup,
        f.meshGroup,
        () => f.materialGroup,
        'deferred',
        undefined,
        formats,
      );
    } finally {
      pass.end();
    }
  };
  try {
    record(['rgba8unorm', 'r32uint', 'rg16float']);
    expect(lookup).toHaveBeenCalledTimes(2);
    const first = lookup.mock.calls[0]?.[17];
    expect(first).toEqual(['r32uint', 'rg16float']);
    expect(lookup.mock.calls[1]?.[17]).toBe(first);
    expect(f.receipts.map(({ entity }) => entity)).toEqual([1, 2, 3]);

    // A new pass owns its ordered targets and must re-enter the runtime PSO
    // authority, including when the same shader/materials are still alive.
    record(['rgba8unorm', 'rg16float', 'r32uint']);
    expect(lookup).toHaveBeenCalledTimes(4);
    const second = lookup.mock.calls[2]?.[17];
    expect(second).toEqual(['rg16float', 'r32uint']);
    expect(second).not.toBe(first);
    expect(lookup.mock.calls[3]?.[17]).toBe(second);
    expect(f.errors).toEqual([]);
  } finally {
    lookup.mockRestore();
    f.dispose();
  }
});

it('keeps absent, Standard fallback and authored output contracts distinct and rejects reordered outputs', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 1 });
  const standard = f.add({ entity: 2, submeshes: 1 });
  standard.source.material.adopt({
    ...standard.source.material.snapshot,
    materialShaderId: 'forgeax::default-standard-pbr',
  });
  const authored = f.add({ entity: 3, submeshes: 1 });
  const outputs = [
    { name: 'color', format: 'rgba8unorm' as const },
    { name: 'extra', format: 'rg16float' as const },
  ];
  authored.source.material.adopt({
    ...authored.source.material.snapshot,
    renderState: { outputs },
  });
  Object.assign(f.c, { reflectionFallbackColorFormat: 'r32uint' });
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const record = (formats: readonly GPUTextureFormat[]) => {
    f.acceptMaterials();
    const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
    try {
      recordGeometryDraws(
        f.c,
        pass,
        null,
        [[0], [0], [0]],
        1,
        f.meshGroup,
        f.meshGroup,
        () => f.materialGroup,
        'forward',
        undefined,
        formats,
      );
    } finally {
      pass.end();
    }
  };
  try {
    record(['rgba8unorm', 'rg16float']);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(lookup.mock.calls.map((args) => args[17])).toEqual([
      undefined,
      ['r32uint'],
      ['rg16float'],
    ]);
    expect(f.receipts.map(({ entity }) => entity)).toEqual([1, 2, 3]);
    Object.assign(f.c, { reflectionFallbackColorFormat: 'rgba16float' });
    record(['rgba8unorm', 'rg16float']);
    expect(lookup.mock.calls[4]?.[17]).toEqual(['rgba16float']);
    expect(lookup.mock.calls[5]?.[17]).toEqual(['rg16float']);
    // Sharing a pass signature never admits a material whose declared targets
    // disagree with the graph's ordered attachment ABI.
    expect(() => record(['rg16float', 'rgba8unorm'])).toThrow(
      'material outputs match the graph attachments in location order',
    );
    expect(f.errors).toEqual([]);
  } finally {
    lookup.mockRestore();
    f.dispose();
  }
});
