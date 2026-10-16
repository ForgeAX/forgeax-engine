import { createHash } from 'node:crypto';
import { err, RhiError } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import {
  directDfgLutBytes,
  ShaderRegistry,
  STANDARD_DIRECT_DFG_LUT_BINDING,
} from '@forgeax/engine-shader';
import {
  type ParamSchemaEntry,
  ParamSchemaProjectionOwner,
  projectMaterialParameterSchema,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMaterialLayoutCache } from '../assembly/material/layout-cache';
import { DeviceScope } from '../device/device-scope';
import { getOrCreateDirectDfgLut, materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import { MaterialSampledTextureBudgetExceededError } from '../errors/render';
import { Materials } from '../materials';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from '../pipeline-spec';

afterEach(() => vi.restoreAllMocks());

describe('material-owned direct DFG texture', () => {
  it('preserves the independent Three.js r184 RG16F bytes', () => {
    const bytes = directDfgLutBytes();
    expect(bytes.byteLength).toBe(1024);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'b41ba8e2bd29fa007dfbf034d4d58b853f378062183847846b1f6d228f2c7e79',
    );
  });

  it('requires the actual optional u32 parameter, including disabled children of LUT roots', () => {
    expect(materialUsesDirectDfgLut(undefined)).toBe(false);
    expect(materialUsesDirectDfgLut([])).toBe(false);
    const lut: ParamSchemaEntry = { name: 'directMultiscatteringLut', type: 'u32', default: 0 };
    const wrongType: ParamSchemaEntry = {
      name: 'directMultiscatteringLut',
      type: 'f32',
      default: 1,
    };
    expect(materialUsesDirectDfgLut([lut])).toBe(true);
    expect(materialUsesDirectDfgLut([wrongType])).toBe(false);
  });

  it('uses the admitted schema revision without retaining caller mutations', () => {
    const owner = new ParamSchemaProjectionOwner();
    const authored: ParamSchemaEntry[] = [{ name: 'directMultiscatteringLut', type: 'u32' }];
    const first = owner.admit({ ownerId: 'dfg', revision: 1, schema: authored });
    authored[0] = { name: 'directMultiscatteringLut', type: 'f32' };
    const next = owner.admit({ ownerId: 'dfg', revision: 2, schema: authored });
    expect(materialUsesDirectDfgLut(first.schema)).toBe(true);
    expect(materialUsesDirectDfgLut(next.schema)).toBe(false);
    expect(materialUsesDirectDfgLut(authored)).toBe(false);
  });

  it('reobserves mutable and shallow-frozen compatibility inputs on every call', () => {
    let type = 'f32';
    let observations = 0;
    const entry = {
      name: 'directMultiscatteringLut',
      get type() {
        observations++;
        return type;
      },
    };
    const schema = Object.freeze([entry]);
    expect(materialUsesDirectDfgLut(schema)).toBe(false);
    type = 'u32';
    expect(materialUsesDirectDfgLut(schema)).toBe(true);
    entry.name = 'unrelated';
    expect(materialUsesDirectDfgLut(schema)).toBe(false);
    expect(observations).toBe(2);
  });

  it('adds exactly one filtered texture to actual Standard material layouts only on request', () => {
    const spec: PipelineSpec = {
      shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    };
    const layout = (mode: 'fit' | 'lut') =>
      Array.from(
        buildBindGroupLayoutDescriptor(spec, {
          kind: 'pbr-material-merged',
          materialParamSchema: Materials.standard({
            baseColor: [1, 1, 1, 1],
            directMultiscattering: mode,
          }).parameters as never,
          caps: { storageBuffer: true, transmissionBackdrop: false },
        }).entries,
      );
    const fit = layout('fit');
    const lut = layout('lut');
    expect(lut.filter((entry) => entry.binding !== STANDARD_DIRECT_DFG_LUT_BINDING)).toEqual(fit);
    expect(lut.find((entry) => entry.binding === STANDARD_DIRECT_DFG_LUT_BINDING)).toMatchObject({
      texture: { sampleType: 'float', viewDimension: '2d' },
    });
  });

  it('refuses an opted-in material before creating a layout when the real bindings exceed the device budget', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    vi.spyOn(device, 'limits', 'get').mockReturnValue({
      maxSampledTexturesPerShaderStage: 1,
    } as never);
    const schema = Materials.standard({
      baseColor: [1, 1, 1, 1],
      directMultiscattering: 'lut',
    }).parameters;
    const make = vi.spyOn(device, 'createBindGroupLayout');
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const projected = projectMaterialParameterSchema(schema ?? [], 'game::lut', 'runtime');
    if (!projected.ok) throw projected.error;
    registry.installMaterialArtifact('game::lut', { source: '', paramSchema: projected.value });
    const cache = createMaterialLayoutCache({
      currentPipelineCacheState: () => ({ perShaderMaterialLayoutCache: new Map() }) as never,
      currentPipelineState: () => ({}) as never,
      currentBuildDevice: () => device,
      getShader: () => registry,
      viewAndSceneDepthLayoutEntries: () => [],
      reportError: (error) => {
        throw error;
      },
    });
    expect(() => cache.getOrBuildPerShaderMaterialLayout('game::lut')).toThrow(
      MaterialSampledTextureBudgetExceededError,
    );
    expect(make).not.toHaveBeenCalled();
  });

  it('uploads once across materials, retires once and rebuilds for the next generation', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const create = vi.spyOn(device, 'createTexture');
    const upload = vi.spyOn(device.queue, 'writeTexture');
    const destroy = vi.spyOn(device, 'destroyTexture');
    const scope = DeviceScope.create(1, 'dfg-test');
    // Default material preparation never asks the owner for a texture.
    if (materialUsesDirectDfgLut([])) getOrCreateDirectDfgLut(device, scope).unwrap();
    expect(create).not.toHaveBeenCalled();
    const first = getOrCreateDirectDfgLut(device, scope).unwrap();
    expect(getOrCreateDirectDfgLut(device, scope).unwrap()).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const staging = upload.mock.calls[0]?.[1] as Uint8Array;
    const bytes = directDfgLutBytes();
    for (let row = 0; row < 16; row++)
      expect(staging.subarray(row * 256, row * 256 + 64)).toEqual(
        bytes.subarray(row * 64, (row + 1) * 64),
      );
    expect(scope.resourceDelta()).toBe(1);
    scope.retire();
    scope.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(getOrCreateDirectDfgLut(device, scope).ok).toBe(false);
    const next = DeviceScope.create(2, 'dfg-test');
    expect(getOrCreateDirectDfgLut(device, next).unwrap().view).not.toBe(first.view);
    expect(upload).toHaveBeenCalledTimes(2);
    next.dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it.each([
    'upload',
    'view',
    'sampler',
  ] as const)('cleans a failed %s before retry without caching partial state', async (stage) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(1, `dfg-fail-${stage}`);
    const failure = err(
      new RhiError({ code: 'rhi-not-available', expected: 'injected failure', hint: 'test' }),
    );
    if (stage === 'upload') vi.spyOn(device.queue, 'writeTexture').mockReturnValueOnce(failure);
    if (stage === 'view') vi.spyOn(device, 'createTextureView').mockReturnValueOnce(failure);
    if (stage === 'sampler') vi.spyOn(device, 'createSampler').mockReturnValueOnce(failure);
    const destroy = vi.spyOn(device, 'destroyTexture');
    expect(getOrCreateDirectDfgLut(device, scope)).toBe(failure);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(scope.resourceDelta()).toBe(0);
    expect(getOrCreateDirectDfgLut(device, scope).ok).toBe(true);
    scope.dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('retains a failed allocation when its initial destruction fails, then retries on scope disposal', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(1, 'dfg-failed-destroy');
    const failure = err(
      new RhiError({ code: 'rhi-not-available', expected: 'injected failure', hint: 'test' }),
    );
    vi.spyOn(device.queue, 'writeTexture').mockReturnValueOnce(failure);
    const destroy = vi.spyOn(device, 'destroyTexture').mockReturnValueOnce(failure);
    expect(getOrCreateDirectDfgLut(device, scope)).toBe(failure);
    expect(scope.resourceDelta()).toBe(1);
    scope.dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(scope.resourceDelta()).toBe(0);
  });
});
