import { rhi } from '@forgeax/engine-rhi-null';
import { SINGLE_LAYER_WATER_PASS_OUTPUTS } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  MaterialPipelineRequestCache,
  materialPipelineRequestFacts,
} from '../../assembly/material/pipeline-request-cache';
import { buildPipelineDescriptor, cacheKeyOf, type PipelineSpec } from '../../pipeline-spec';
import { FORWARD_PASS_SELECTOR } from '../../systems/pass-selector';
import { prepareMainPassPipelines } from '../main-pass';
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
      ['rg16float'],
      ['rg16float'],
    ]);
    expect(f.receipts.map(({ entity }) => entity)).toEqual([1, 2, 3]);
    Object.assign(f.c, { reflectionFallbackColorFormat: 'rgba16float' });
    record(['rgba8unorm', 'rg16float']);
    expect(lookup.mock.calls[4]?.[17]).toEqual(['rg16float']);
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

it.each([
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-standard-pbr-skin',
])('passes the complete Forward SSR fallback and response MRT for %s', async (materialShaderId) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const standard = f.add({ entity: 1, submeshes: 1 });
  standard.source.material.adopt({
    ...standard.source.material.snapshot,
    materialShaderId,
  });
  Object.assign(f.c, { reflectionFallbackColorFormat: 'rgba16float' });
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.acceptMaterials();
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
      ['rgba16float', 'rgba16float', 'rgba16float'],
    );
    expect(lookup.mock.calls[0]?.[17]).toEqual(['rgba16float', 'rgba16float']);
    expect(lookup.mock.calls[0]?.[5]).toContain('REFLECTION_FALLBACK_AVAILABLE=true');
  } finally {
    pass.end();
    lookup.mockRestore();
    f.dispose();
  }
});

const waterPasses = [
  ['water-prepass', 'depth', 'fs_water_prepass'],
  ['water-color', 'color', 'fs_water_color'],
  ['water-shadow', 'shadow', 'fs_water_shadow'],
  ['water-velocity', 'velocity', 'fs_water_velocity'],
] as const;

it('prepares an explicit opaque-normal entry at four samples with equal-depth read-only admission', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 1 });
  Object.assign(entry.source, {
    pipelinePreparation: [
      {
        materialHandle: 7,
        passIndex: 0,
        tags: { LightMode: 'Forward' },
        materialShaderId: entry.source.material.snapshot.materialShaderId,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
      },
    ],
  });
  Object.assign(f.c, { pipelinePreparationEntries: [entry] });
  f.acceptMaterials();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    prepareMainPassPipelines(
      f.c,
      FORWARD_PASS_SELECTOR,
      { passKind: 'forward', recordMode: 'opaque', fragmentEntryPoint: 'fs_ao_input_msaa' },
      4,
      ['rgba8uint'],
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    const request = lookup.mock.calls[0];
    if (request === undefined) throw new Error('missing normal pipeline request');
    expect(request[19]).toBe('fs_ao_input_msaa');
    const fragmentEntry = request[19];
    if (fragmentEntry === undefined) throw new Error('missing explicit normal fragment entry');
    expect(
      buildPipelineDescriptor(
        {
          shader: {
            id: request[0],
            passKind: request[6] ?? 'forward',
            variantSet: request[5],
            fragmentEntry,
          },
          attachments: {
            colorFormats: ['rgba8uint'],
            depthFormat: 'depth32float-stencil8',
            sampleCount: 4,
          },
          geometry: { topology: 'triangle-list', vertexLayout: {} },
          renderState: request[2],
        },
        { vertex: module, fragment: module },
      ),
    ).toMatchObject({
      multisample: { count: 4 },
      depthStencil: { depthCompare: 'greater-equal', depthWriteEnabled: false },
      fragment: { entryPoint: 'fs_ao_input_msaa', targets: [{ format: 'rgba8uint' }] },
    });
  } finally {
    lookup.mockRestore();
    f.dispose();
  }
});

it('requests a colorless PSO only when the forward pass binds no color target', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 1 });
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const record = (formats: readonly GPUTextureFormat[]) => {
    f.acceptMaterials();
    const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
    try {
      recordGeometryDraws(
        f.c,
        pass,
        null,
        [[0]],
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
    // Sprite transparent sub-passes record into the color target and must say so.
    record(['rgba16float']);
    expect(lookup.mock.calls.at(-1)?.[9]).not.toBeNull();
    record([]);
    expect(lookup.mock.calls.at(-1)?.[9]).toBeNull();
    expect(f.errors).toEqual([]);
  } finally {
    lookup.mockRestore();
    f.dispose();
  }
});

it('prepares distinct Water pipelines with equal-depth read-only velocity and fixed Surface outputs', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 1 });
  const materialShaderId = 'test::compatible-water-root';
  entry.source.material.adopt({
    ...entry.source.material.snapshot,
    materialShaderId,
    surfaceModel: 'single-layer-water',
  });
  Object.assign(entry.source, {
    pipelinePreparation: [
      {
        materialHandle: 7,
        passIndex: 0,
        tags: { LightMode: 'Forward' },
        materialShaderId,
        vertexEntry: 'vs_main',
        fragmentEntry: 'fs_main',
      },
    ],
  });
  Object.assign(f.c, { pipelinePreparationEntries: [entry] });
  f.acceptMaterials();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const requests = new MaterialPipelineRequestCache<object>();
  const specKeys = new Set<string>();
  try {
    for (const [index, [mode, surfacePass, fragmentEntryPoint]] of waterPasses.entries()) {
      const outputs = SINGLE_LAYER_WATER_PASS_OUTPUTS[surfacePass];
      const colorFormats = outputs.map((output) => output.format);
      prepareMainPassPipelines(
        f.c,
        FORWARD_PASS_SELECTOR,
        { recordMode: mode, fragmentEntryPoint },
        1,
        colorFormats,
      );
      expect(lookup).toHaveBeenCalledTimes(index + 1);
      const request = lookup.mock.calls[index];
      expect(request).toBeDefined();
      if (request === undefined) throw new Error('Water pipeline request is required');
      expect(request[0]).toBe(materialShaderId);
      expect(request[2]?.outputs).toBe(outputs);
      expect(request[17]).toEqual(colorFormats.slice(1));
      expect(request[19]).toBe(fragmentEntryPoint);
      const spec: PipelineSpec = {
        shader: {
          id: request[0],
          passKind: request[6] ?? 'forward',
          variantSet: request[5],
          fragmentEntry: fragmentEntryPoint,
        },
        attachments: { colorFormats, depthFormat: 'depth32float', sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: request[2],
      };
      const descriptor = buildPipelineDescriptor(spec, { vertex: module, fragment: module });
      expect(descriptor).toMatchObject({
        depthStencil: {
          depthCompare: surfacePass === 'velocity' ? 'greater-equal' : 'greater',
          depthWriteEnabled: surfacePass !== 'velocity',
        },
      });
      if (colorFormats.length === 0) expect(descriptor.fragment).toBeUndefined();
      else
        expect(descriptor.fragment).toMatchObject({
          entryPoint: fragmentEntryPoint,
          targets: colorFormats.map((format) => ({ format })),
        });
      const facts = materialPipelineRequestFacts(request);
      expect(requests.get(facts)).toBeUndefined();
      const cached = {};
      requests.set(facts, cached);
      expect(requests.get(materialPipelineRequestFacts(request))).toBe(cached);
      specKeys.add(cacheKeyOf(spec));
      const alternateDepth = {
        depthWriteEnabled: surfacePass === 'velocity',
        depthCompare: surfacePass === 'velocity' ? ('less' as const) : ('less-equal' as const),
      };
      const alternateRequest = [...request] as typeof request;
      alternateRequest[2] = { ...request[2], ...alternateDepth };
      expect(requests.get(materialPipelineRequestFacts(alternateRequest))).toBeUndefined();
      expect(
        cacheKeyOf({ ...spec, renderState: { ...spec.renderState, ...alternateDepth } }),
      ).not.toBe(cacheKeyOf(spec));
    }
    expect(specKeys.size).toBe(waterPasses.length);
    expect(f.receipts).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    lookup.mockRestore();
    f.dispose();
  }
});
