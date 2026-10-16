import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { STANDARD_TEXTURE_MASK_OVERRIDE } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import type { DispatchEntry } from '../../render-system-extract';
import { recordGeometryDraws } from '../main-pass-geometry';
import { prepareShadowMaterialPipelines } from '../shadow-pass';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

const pass = (mode = 'Forward'): Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'> => ({
  materialHandle: 7,
  passIndex: 0,
  queue: 2000,
  layer: 0,
  tags: { LightMode: mode },
  renderState: { cullMode: 'none' },
  defines: undefined,
  materialShaderId: 'test::prepared',
  vertexEntry: 'vertex',
  fragmentEntry: 'fragment',
  paramSnapshot: undefined,
});
async function setup() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 1 });
  const authoredPass = pass();
  Object.assign(entry.source, { authorVisible: false, pipelinePreparation: [authoredPass] });
  Object.assign(entry.source.material, { materialShaderId: 'test::prepared' });
  Object.assign(f.c, { validatedOrdered: [], pipelinePreparationEntries: [entry] });
  const encode = () => {
    const encoder = device
      .createCommandEncoder()
      .unwrap()
      .beginRenderPass({ colorAttachments: [] });
    const commands = [
      vi.spyOn(encoder, 'draw'),
      vi.spyOn(encoder, 'drawIndexed'),
      vi.spyOn(encoder, 'setPipeline'),
      vi.spyOn(encoder, 'setBindGroup'),
      vi.spyOn(encoder, 'setVertexBuffer'),
    ];
    recordGeometryDraws(
      f.c,
      encoder,
      null,
      [],
      1,
      f.meshGroup,
      f.meshGroup,
      () => f.materialGroup,
      'forward',
      undefined,
      ['rgba8unorm'],
      false,
      undefined,
      undefined,
      false,
      undefined,
      (p) => p.tags.LightMode === 'Forward',
    );
    for (const command of commands) expect(command).not.toHaveBeenCalled();
    encoder.end();
  };
  return { ...f, entry, authoredPass, encode };
}

it('requires the authored PSO and emits no draw, binding or visibility mutation', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    lookup.mockReturnValueOnce(null);
    f.encode();
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    expect(f.entry.source.authorVisible).toBe(false);
    expect(f.receipts).toEqual([]);
    f.c.frameState.pipelinePreparationPending = false;
    f.encode();
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1]?.[18]).toBe('vertex');
    expect(lookup.mock.calls[1]?.[19]).toBe('fragment');
  } finally {
    f.dispose();
  }
});

it('uses the identical selection for preparation and visible direct drawing', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    f.encode();
    const hiddenRequest = lookup.mock.calls[0];
    Object.assign(f.c, { pipelinePreparationEntries: [], validatedOrdered: [f.entry] });
    const encoder = f.c.runtime.device
      .createCommandEncoder()
      .unwrap()
      .beginRenderPass({ colorAttachments: [] });
    recordGeometryDraws(
      f.c,
      encoder,
      null,
      [[0]],
      1,
      f.meshGroup,
      f.meshGroup,
      () => f.materialGroup,
      'forward',
      [{ ...f.authoredPass, entityIndex: 1, renderableIndex: 0 }],
      ['rgba8unorm'],
    );
    encoder.end();
    expect(lookup.mock.calls[1]).toEqual(hiddenRequest);
    expect(f.receipts).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('observes changed authored state, source program, mask and geometry layout', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    f.encode();
    const before = lookup.mock.calls[0];
    Object.assign(f.authoredPass, {
      materialShaderId: 'test::replacement',
      renderState: { cullMode: 'front' },
      vertexEntry: 'replacement',
    });
    Object.assign(f.entry.source.material, { standardTextureMask: 5 });
    f.encode();
    const after = lookup.mock.calls[1];
    expect(after?.[0]).toBe('test::replacement');
    expect(after?.[2]).not.toEqual(before?.[2]);
    expect(after?.[18]).toBe('replacement');
    expect(after?.[21]).toEqual({ [STANDARD_TEXTURE_MASK_OVERRIDE]: 5 });
    Object.assign(f.entry.mesh, {
      layoutProjection: deriveVertexLayoutProjection({
        position: Float32Array.of(0, 0, 0),
        color: Float32Array.of(1, 1, 1, 1),
      }),
    });
    f.encode();
    expect(lookup.mock.calls[2]?.[13]).not.toEqual(before?.[13]);
  } finally {
    f.dispose();
  }
});

it('prepares only authored ShadowCaster passes through validated module readiness', async () => {
  const f = await setup();
  const shadow = pass('ShadowCaster');
  Object.assign(f.entry.source, { pipelinePreparation: [f.authoredPass, shadow] });
  const lookup = vi.fn().mockReturnValue(null);
  Object.assign(f.c.runtime, { getMaterialShaderPipeline: lookup });
  try {
    prepareShadowMaterialPipelines(f.c, true, () => false);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[6]).toBe('shadow-caster');
    expect(lookup.mock.calls[0]?.[14]).toBe('validated');
    expect(lookup.mock.calls[0]?.[18]).toBe('vertex');
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    f.c.frameState.pipelinePreparationPending = false;
    lookup.mockReturnValue(f.pipeline);
    prepareShadowMaterialPipelines(f.c, true, () => false);
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(f.entry.source.authorVisible).toBe(false);
  } finally {
    f.dispose();
  }
});
