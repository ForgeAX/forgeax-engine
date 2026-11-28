import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { ok, sha256 } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { resolveMaterialPipelineBindGroups } from '../../assembly/material/pipeline-helpers';
import { buildBindGroupLayoutDescriptor } from '../../pbr-pipeline';
import type { PipelineSpec } from '../../pipeline-spec';
import {
  createGeometryPipelineRequests,
  type GeometryPipelineRequestContext,
  geometryPipelineRequestContext,
  type PipelineRequestRuntime,
} from '../geometry-pipeline-requests';
import type { MaterialShaderPipelineEntry } from '../render-context';

describe('direct medium geometry pipeline layout', () => {
  const spec: PipelineSpec = {
    shader: { id: 'test::medium', passKind: 'temporal', variantSet: undefined },
    attachments: { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
  const caps = { storageBuffer: true, probeBlend: true };
  const direct = buildBindGroupLayoutDescriptor(spec, {
    kind: 'pbr-surface-direct-instances',
    caps,
  });
  const probe = buildBindGroupLayoutDescriptor(spec, { kind: 'pbr-instances', caps });
  const scene = buildBindGroupLayoutDescriptor(spec, { kind: 'pbr-gpu-driven-instances', caps });
  const mesh = { label: 'mesh' } as never;
  const cluster = { label: 'cluster' } as never;
  const state = {
    meshBindGroupLayout: mesh,
    hdrpMeshBindGroupLayout: cluster,
    gpuDrivenPrimitiveBindGroupLayout: { label: 'scene-primitive' } as never,
    pbrSkinMeshBindGroupLayout: null,
    hdrpSkinMeshBindGroupLayout: null,
    instancesBindGroupLayout: probe as never,
    probeInstancesBindGroupLayout: probe as never,
    surfaceDirectInstancesBindGroupLayout: direct as never,
    gpuDrivenInstancesBindGroupLayout: scene as never,
  };

  it.each([
    ['forward', false, 'single-layer-medium', true],
    ['forward', true, 'single-layer-medium', true],
    ['temporal', false, 'single-layer-medium', true],
    ['temporal', true, 'single-layer-medium', true],
    ['temporal', false, 'standard', false],
    ['deferred', false, 'single-layer-medium', false],
    ['shadow-caster', false, 'single-layer-medium', false],
    ['forward', false, 'standard', false, true],
  ] as const)('resolves %s, clustered=%s, surface=%s to its address contract', (passKind, clustered, surfaceModel, directAddress, coldFog) => {
    const program = createMaterialShaderProgram(`
      @group(3) @binding(1) var<storage, read> probes: array<vec4<f32>>;
      @group(3) @binding(6) var<uniform> surfaceDirectAddress: vec4<u32>;
      @vertex fn vs_temporal() -> @builtin(position) vec4<f32> {
        return vec4<f32>(f32(surfaceDirectAddress.x), 0.0, 0.0, 1.0);
      }
      @fragment fn fs_temporal() -> @location(0) vec4<f32> { return probes[0]; }
    `);
    const shaders = new ShaderRegistry({ manifestUrl: undefined });
    const prepare = vi.fn(async () => ok(new TextEncoder().encode(program.source)));
    if (coldFog === true) {
      shaders.installMaterialArtifactSource('test::medium', {
        digest: `sha256:${sha256(program.source)}`,
        paramSchema: [],
        receipt: { ...createStandardPbrArtifactReceipt(), forwardFog: 'height-vertex/1' },
        prepare,
      });
    }
    const ready = { pipeline: {} } as MaterialShaderPipelineEntry;
    const lookup = vi.fn().mockReturnValue(ready);
    const requests = createGeometryPipelineRequests(
      {
        runtime: {
          device: { caps, limits: { maxSampledTexturesPerShaderStage: 32 } },
          getMaterialArtifact: () => ({ program }),
          getMaterialShaderArtifact: () => (coldFog === true ? undefined : { program }),
          shaderRegistry: shaders,
          getMaterialShaderPipelineEntry: lookup,
          prepareMaterialShaderPipelineEntry: lookup,
        },
        pipelineState: {},
        vertexHeightFog: coldFog === true,
        lightingKind: clustered ? 'clustered' : 'no-local-lights',
        warnedNineSliceScaleEntities: new Set<number>(),
      } as unknown as GeometryPipelineRequestContext,
      {
        passKind,
        sampleCount: 1,
        colorFormats: ['rgba16float'],
        coverageOnly: false,
        tonemapActive: true,
        msaaActive: false,
        viewBindGroupDynamicOffset: 0,
        transparentDepthWrite: false,
        oit: undefined,
      },
    );
    const projection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
    const material = {
      materialShaderId: 'test::medium',
      surfaceModel,
      paramSnapshot: {},
      renderState: { cullMode: 'none' },
    };
    const entry = {
      source: {
        transform: {
          world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        },
      },
      mesh: { layoutProjection: projection, indexFormat: 'uint16' },
    };
    expect(
      requests.resolveDrawPipeline(
        entry as Parameters<typeof requests.resolveDrawPipeline>[0],
        'triangle-list',
        material as Parameters<typeof requests.resolveDrawPipeline>[2],
        undefined,
        undefined,
        material.renderState as never,
        passKind === 'temporal' ? 'vs_temporal' : undefined,
        passKind === 'temporal' ? 'fs_temporal' : undefined,
        false,
        undefined,
        projection,
        false,
      ),
    ).toBe(true);
    const call = lookup.mock.calls[0];
    expect(call).toBeDefined();
    if (directAddress) {
      expect(call?.[5]).toContain('STORAGE_BUFFER_AVAILABLE=true');
      expect(call?.[5]).toContain('PROBE_BLEND_AVAILABLE=true');
    }
    expect(call?.[6]).toBe(passKind);
    expect(call?.[18]).toBe(passKind === 'temporal' ? 'vs_temporal' : undefined);
    const layouts = resolveMaterialPipelineBindGroups(
      call?.[15] ?? (clustered ? 'hdrp-pbr' : 'pbr'),
      state,
      program.probeBlendRecordRequired,
    );
    expect(layouts?.instancesLayout).toBe(directAddress ? direct : probe);
    expect(layouts?.meshLayout).toBe(clustered ? cluster : mesh);
    expect(direct.entries.find((entry) => entry.binding === 6)?.buffer?.type).toBe('uniform');
    expect(requests.pipelineSelection.sceneDirect).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps the ordinary probe and scene-index address contracts separate', () => {
    expect(resolveMaterialPipelineBindGroups('pbr', state, true)?.instancesLayout).toBe(probe);
    expect(probe.entries.some((entry) => entry.binding === 6)).toBe(false);
    expect(resolveMaterialPipelineBindGroups('gpu-driven-pbr', state)?.instancesLayout).toBe(scene);
    expect(scene.entries.find((entry) => entry.binding === 6)?.buffer?.type).toBe(
      'read-only-storage',
    );
  });
});

describe('main-pass material pipeline cache', () => {
  it.each([
    'forward',
    'deferred',
    'temporal',
  ] as const)('selects the owned preparation path for %s draws', (passKind) => {
    const ready = {} as MaterialShaderPipelineEntry;
    const getter = vi.fn().mockReturnValue(ready);
    const prepare = vi.fn().mockReturnValue(null);
    const requests = createGeometryPipelineRequests(
      {
        runtime: {
          getMaterialShaderPipelineEntry: getter,
          prepareMaterialShaderPipelineEntry: prepare,
        },
      } as unknown as GeometryPipelineRequestContext,
      {
        passKind,
        sampleCount: 1,
        colorFormats: ['rgba8unorm'],
        coverageOnly: false,
        tonemapActive: false,
        msaaActive: false,
        viewBindGroupDynamicOffset: 0,
        transparentDepthWrite: false,
        oit: undefined,
      },
    );
    const entry = requests.resolveMaterialPipeline(
      'test::policy',
      {},
      'triangle-list',
      'uint16',
      undefined,
      undefined,
      deriveVertexLayoutProjection({ position: new Float32Array(9) }),
    );
    if (passKind === 'temporal') {
      expect(entry).toBe(ready);
      expect(getter).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
    } else {
      expect(entry).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it('keeps immediate and prepared temporal requests with their issuing factory', () => {
    const visible = {} as MaterialShaderPipelineEntry;
    const staged = {} as MaterialShaderPipelineEntry;
    const get = vi.fn().mockReturnValue(visible);
    const prepare = vi.fn().mockReturnValueOnce(null).mockReturnValue(staged);
    const issued: unknown[] = [];
    const requests = createGeometryPipelineRequests(
      {
        runtime: {
          getMaterialShaderPipelineEntry: get,
          prepareMaterialShaderPipelineEntry: prepare,
        },
      } as unknown as GeometryPipelineRequestContext,
      {
        passKind: 'temporal',
        sampleCount: 1,
        colorFormats: ['rgba8unorm'],
        coverageOnly: false,
        tonemapActive: false,
        msaaActive: false,
        viewBindGroupDynamicOffset: 0,
        transparentDepthWrite: false,
        oit: undefined,
      },
      (_phase, action) => {
        const result = action();
        issued.push(result);
        return result;
      },
      'record/graph-execute/forward/pipeline-selection',
    );
    const layout = deriveVertexLayoutProjection({ position: new Float32Array(9) });
    const resolve = (preparation: boolean) =>
      requests.resolveMaterialPipeline(
        'test::temporal',
        undefined,
        'triangle-list',
        'uint16',
        undefined,
        undefined,
        layout,
        undefined,
        undefined,
        undefined,
        undefined,
        preparation,
      );
    expect(resolve(false)).toBe(visible);
    expect(resolve(true)).toBeNull();
    expect(resolve(true)).toBe(staged);
    expect(resolve(false)).toBe(visible);
    expect(resolve(true)).toBe(staged);
    expect(get).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(issued).toEqual([visible, null, staged]);
  });

  it('keeps transient pending pipelines retryable across a tight frame loop', () => {
    // The resolver treats a resolved entry as opaque; no device or draw state
    // belongs to this lookup-only test.
    const ready = {} as MaterialShaderPipelineEntry;
    const lookup = vi
      .fn<NonNullable<PipelineRequestRuntime['getMaterialShaderPipelineEntry']>>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(ready);
    const context = {
      runtime: { getMaterialShaderPipelineEntry: lookup },
    } as unknown as GeometryPipelineRequestContext;
    const requests = createGeometryPipelineRequests(context, {
      passKind: 'forward',
      sampleCount: 1,
      colorFormats: ['rgba8unorm'],
      coverageOnly: false,
      tonemapActive: false,
      msaaActive: false,
      viewBindGroupDynamicOffset: 0,
      transparentDepthWrite: false,
      oit: undefined,
    });
    const projection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
    const resolve = () =>
      requests.resolveMaterialPipeline(
        'test::pending',
        {},
        'triangle-list',
        'uint16',
        undefined,
        undefined,
        projection,
      );
    expect(resolve()).toBeNull();
    expect(resolve()).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(resolve()).toBe(ready);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(resolve()).toBe(ready);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it.each([
    { simpleReceiver: true, leanLighting: false },
    { simpleReceiver: true, leanLighting: true },
    { simpleReceiver: false, leanLighting: true },
  ])('preserves receiver=$simpleReceiver and lean=$leanLighting while its PSO builds', ({
    simpleReceiver,
    leanLighting,
  }) => {
    const general = { pipeline: {} } as MaterialShaderPipelineEntry;
    const simple = { pipeline: {} } as MaterialShaderPipelineEntry;
    let simpleReady = false;
    const lookup = vi
      .fn<NonNullable<PipelineRequestRuntime['getMaterialShaderPipelineEntry']>>()
      .mockImplementation((...args) =>
        /DIRECTIONAL_SHADOW_SIMPLE=true|LEAN_LIGHTING=true/.test(String(args[5]))
          ? simpleReady
            ? simple
            : null
          : general,
      );
    const context = {
      runtime: { getMaterialShaderPipelineEntry: lookup },
      directionalShadowSimple: simpleReceiver,
      leanLighting,
    } as unknown as GeometryPipelineRequestContext;
    const requests = createGeometryPipelineRequests(context, {
      passKind: 'forward',
      sampleCount: 1,
      colorFormats: ['rgba8unorm'],
      coverageOnly: false,
      tonemapActive: false,
      msaaActive: false,
      viewBindGroupDynamicOffset: 0,
      transparentDepthWrite: false,
      oit: undefined,
    });
    const projection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
    const resolve = () =>
      requests.resolveMaterialPipeline(
        'forgeax::default-standard-pbr',
        {},
        'triangle-list',
        'uint16',
        undefined,
        undefined,
        projection,
      );
    // A device callback may resolve an unrelated draw while this specialization is pending.
    lookup.mockImplementationOnce(() => {
      expect(
        requests.resolveMaterialPipeline(
          'test::nested',
          {},
          'triangle-list',
          'uint16',
          undefined,
          undefined,
          projection,
        ),
      ).toBe(general);
      return null;
    });
    // A frame that just turned simple (e.g. the light stopped casting) is not held.
    expect(resolve()).toBe(general);
    const requested = lookup.mock.calls.map((call) => String(call[5]));
    expect(requested[0]).toContain(`DIRECTIONAL_SHADOW_SIMPLE=${simpleReceiver}`);
    expect(requested[0]).toContain(`LEAN_LIGHTING=${leanLighting}`);
    expect(requested[2]).not.toContain('DIRECTIONAL_SHADOW_SIMPLE=true');
    expect(requested[2]).not.toContain('LEAN_LIGHTING=true');
    // The fallback is not memoized under the simple key.
    simpleReady = true;
    expect(resolve()).toBe(simple);
    expect(resolve()).toBe(simple);
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});

it('snapshots lean lighting independently when the next frame adds modifiers', () => {
  const source = {
    camera: {},
    frameState: { warnedNineSliceScaleEntities: new Set<number>() },
    directionalShadowSimple: true,
    leanLighting: true,
  };
  const project = () =>
    geometryPipelineRequestContext(
      source as unknown as Parameters<typeof geometryPipelineRequestContext>[0],
    );
  const before = project();
  source.leanLighting = false;
  const full = project();
  source.leanLighting = true;
  expect(before.leanLighting).toBe(true);
  expect(full.leanLighting).toBe(false);
  expect(project().leanLighting).toBe(true);
  expect(full.directionalShadowSimple).toBe(true);
});
